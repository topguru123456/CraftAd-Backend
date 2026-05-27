import {
  BadGatewayException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AppConfigService } from '../../../config/config.service';

/* Low-level Veo 3 REST wrapper over the Gemini API.
 *
 * One key (`GEMINI_API_KEY`), three operations: submit, poll, download.
 * Higher-level orchestration (when to poll, what to do with the
 * result, how to upload to Storage, how to update the DB row) lives
 * in VeoPollService and VideoDispatchService. This file is the only
 * place that knows the Veo wire shape.
 *
 * Why Gemini API (vs Vertex AI):
 *   The rest of our generative code calls Gemini directly via REST
 *   with the same `GEMINI_API_KEY` (see ai-image.service.ts). Veo 3
 *   is available on the same surface (`generativelanguage.google
 *   apis.com`), so we reuse the auth pattern and avoid pulling in
 *   the GCP service-account dance Vertex would require. Switching
 *   to Vertex later is a URL + auth-header change in this one file.
 *
 * Veo 3 is a long-running operation: `predictLongRunning` returns
 * immediately with an operation name; the caller polls until
 * `done: true`. Submit + each poll = a separate HTTP round-trip.
 * Submit blocks for ~1-3s (it's just queueing the job, not
 * generating). Poll blocks for milliseconds. Generation itself runs
 * for ~1-3min in the background on Google's side.
 */

const VEO_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const VEO_MODEL = 'veo-3.0-generate-001';
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type VeoAspectRatio = '16:9' | '9:16' | '1:1';

export interface VeoSubmitInput {
  prompt: string;
  /* Optional reference image for image-to-video mode. Pass raw bytes;
   * we base64-encode at the call site. */
  referenceImageBytes?: Uint8Array;
  referenceImageMime?: string;
  aspectRatio: VeoAspectRatio;
  durationSeconds: number;
}

export type VeoSubmitResult =
  | { ok: true; operationName: string }
  | { ok: false; reason: string };

export interface VeoPollDoneSuccess {
  done: true;
  status: 'success';
  /* Direct download URL from Veo. SIGNED — valid for ~hours, not
   * forever — so we must download + re-upload to our own Storage
   * before persisting anything user-facing. */
  videoUri: string;
  /* Veo doesn't reliably return a poster across all calls. When it
   * does, we surface it; when it doesn't, the downstream column
   * stays null and the HTML5 player shows its default. */
  posterUri?: string;
}

export interface VeoPollDoneFailure {
  done: true;
  status: 'error';
  message: string;
}

export interface VeoPollPending {
  done: false;
}

export type VeoPollResult =
  | VeoPollDoneSuccess
  | VeoPollDoneFailure
  | VeoPollPending
  | { done: true; status: 'fetch_error'; reason: string };

interface VeoOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  /* Response shape is intentionally `unknown` — Veo's wire has shifted
   * across releases (`generatedSamples[]`, `generatedVideos[]`,
   * `predictions[]`, `candidates[].content.parts[].fileData`, …), and
   * pinning a single TS shape here would force code churn every time
   * Google adjusts. `extractVideoUri` walks the tree at runtime. */
  response?: unknown;
}

/* Recursively walk a Veo operation `response` looking for a video URI.
 * Veo's response shape has changed across releases — we've seen at
 * least these wrappers in the wild:
 *   • response.generatedVideos[].video.uri               (Veo 3 current)
 *   • response.generateVideoResponse.generatedSamples[].video.uri
 *   • response.generateVideoResponse.generatedVideos[].video.uri
 *   • response.predictions[].video.uri | .videoUri
 *   • response.candidates[].content.parts[].fileData.fileUri
 *
 * Rather than enumerating every variant by path, we walk the tree
 * looking for ANY string field whose name suggests a video URL
 * (`uri`/`videoUri`/`fileUri`/`videoUrl`) and whose value points at a
 * Google-hosted video resource. Trades a tiny bit of specificity for
 * resilience to wire changes — and the false-positive surface is
 * narrow because the candidate keys are video-specific. Same approach
 * for posters (separately walks for jpg-shaped URIs).
 *
 * Returns `null` if nothing matches, so the caller knows to log + fail. */
const VIDEO_URI_KEYS = new Set([
  'uri',
  'videoUri',
  'videoUrl',
  'fileUri',
  'url',
]);

function looksLikeVideoUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('http')) return false;
  /* Veo returns either a `:download` operation URL or a direct
   * googleusercontent / generativelanguage path. Both are fine; we
   * just exclude things like jpg/png/webp that are obviously posters
   * (handled separately) and JSON metadata URLs. */
  const lower = value.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return false;
  if (lower.endsWith('.png') || lower.endsWith('.webp')) return false;
  return true;
}

function looksLikePosterUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('http')) return false;
  const lower = value.toLowerCase();
  return (
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.png') ||
    lower.endsWith('.webp')
  );
}

/* Veo's Responsible-AI safety filter can reject a generation AFTER
 * the long-running operation finishes successfully. The response then
 * carries `raiMediaFilteredCount: N > 0` plus `raiMediaFilteredReasons:
 * [...]` and NO video URI. Without detecting this upfront the URI
 * walker comes up empty and we surface a generic "no video URL"
 * message that gives the user nothing actionable.
 *
 * Veo 3 specifically generates audio alongside video — the filter
 * often trips on what it infers the SOUNDSCAPE will contain (e.g.
 * speech-like content, branded music, recognizable voice), not the
 * visual itself. The user-facing message reflects that ambiguity:
 * "try a different description / image" works for both visual and
 * audio rejections.
 *
 * Returns the first reason string found, or null if no RAI filter
 * fired. Walks the response tree because the filter fields have
 * appeared under slightly different parent keys across Veo
 * releases (sometimes under `generateVideoResponse`, sometimes at
 * the response root). */
function extractRaiFilterReason(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const queue: unknown[] = [response];
  let depth = 0;
  while (queue.length > 0 && depth < 200) {
    const node = queue.shift();
    depth += 1;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item);
      continue;
    }
    const obj = node as Record<string, unknown>;
    /* Prefer the human-readable reasons array when present. */
    if (
      Array.isArray(obj.raiMediaFilteredReasons) &&
      obj.raiMediaFilteredReasons.length > 0
    ) {
      const first = obj.raiMediaFilteredReasons[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
    }
    /* Fall back to count-only when reasons array is missing — the
     * filter still fired, we just don't have the wording. */
    if (
      typeof obj.raiMediaFilteredCount === 'number' &&
      obj.raiMediaFilteredCount > 0
    ) {
      return 'Veo safety filter blocked the generation (no detail provided)';
    }
    /* Recurse into children. */
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function walkForUri(
  node: unknown,
  matcher: (v: unknown) => v is string,
  depth = 0,
): string | null {
  /* Bounded depth — Veo responses are never deeper than ~6 levels.
   * Cap keeps us safe against cyclic objects (shouldn't happen with
   * JSON.parse output but cheap insurance). */
  if (depth > 12 || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = walkForUri(item, matcher, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (VIDEO_URI_KEYS.has(key) && matcher(value)) return value;
    /* Recurse into nested objects/arrays. We don't recurse into
     * plain strings/numbers/etc. */
    if (value && typeof value === 'object') {
      const found = walkForUri(value, matcher, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

@Injectable()
export class VeoApiService {
  private readonly logger = new Logger(VeoApiService.name);

  constructor(private readonly config: AppConfigService) {}

  /* Submit a new Veo 3 generation job. Returns the operation name
   * the caller stores on the row for later polling. */
  async submit(input: VeoSubmitInput): Promise<VeoSubmitResult> {
    const apiKey = this.config.require('GEMINI_API_KEY');

    /* Instance shape: prompt is required, image is optional. When
     * provided, image bytes go in as base64 (Veo doesn't accept URLs
     * for this field — same as Gemini image-input).
     *
     * Putting the image inline avoids a separate "upload reference to
     * Veo" round-trip; the cost is the base64 round-trip through our
     * request body. For typical product photos (~1-2MB) this is fine. */
    const instance: Record<string, unknown> = { prompt: input.prompt };
    if (input.referenceImageBytes && input.referenceImageMime) {
      instance.image = {
        bytesBase64Encoded: Buffer.from(input.referenceImageBytes).toString('base64'),
        mimeType: input.referenceImageMime,
      };
    }

    const body = {
      instances: [instance],
      parameters: {
        aspectRatio: input.aspectRatio,
        durationSeconds: input.durationSeconds,
        /* personGeneration is intentionally omitted. Veo 3 on the
         * Gemini API only accepts `allow_adult` (default) and
         * `dont_allow` — `allow_all` exists on Vertex AI for some Veo
         * variants but is rejected here ("allow_all for personGeneration
         * is currently not supported"). The default `allow_adult`
         * already permits incidental human presence (hands holding
         * product, people in lifestyle shots), which is all we need.
         * Set `dont_allow` here later only if a flow needs to explicitly
         * forbid people. */
      },
    };

    const url = `${VEO_BASE}/models/${VEO_MODEL}:predictLongRunning`;
    const result = await this.postJson(url, apiKey, body, SUBMIT_TIMEOUT_MS);
    if (!result.ok) {
      this.logger.warn(`Veo submit failed: ${result.reason}`);
      return result;
    }

    const operationName =
      typeof result.parsed?.name === 'string' ? result.parsed.name : null;
    if (!operationName) {
      this.logger.warn(`Veo submit returned no operation name: ${JSON.stringify(result.parsed).slice(0, 500)}`);
      return { ok: false, reason: 'no_operation_name' };
    }
    return { ok: true, operationName };
  }

  /* Poll one operation. Returns whether it's done, and if so the
   * result. The caller decides what to do on `done=true` (download
   * + upload + DB update). */
  async poll(operationName: string): Promise<VeoPollResult> {
    const apiKey = this.config.require('GEMINI_API_KEY');

    /* operationName comes back from Veo as `models/.../operations/abc`
     * (no leading slash). Path-join cleanly with the base. */
    const url = `${VEO_BASE}/${operationName}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    let response: Response;
    let parsed: VeoOperation | null = null;
    try {
      response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'x-goog-api-key': apiKey },
      });
      parsed = (await response.json()) as VeoOperation;
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        done: true,
        status: 'fetch_error',
        reason: isAbort ? 'veo_poll_timeout' : 'veo_poll_failed',
      };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.logger.warn(`Veo poll non-ok ${response.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
      return {
        done: true,
        status: 'fetch_error',
        reason: `veo_poll_non_ok_${response.status}`,
      };
    }

    if (!parsed?.done) return { done: false };

    if (parsed.error) {
      return {
        done: true,
        status: 'error',
        message: parsed.error.message ?? 'Veo returned an error',
      };
    }

    /* RAI safety-filter check BEFORE the URI walk. Veo can finish an
     * operation "successfully" with a filtered result — the response
     * carries raiMediaFilteredCount/Reasons and no URI. Detecting
     * this here turns it into a clear "content blocked" error
     * instead of a misleading "no video URL" message. */
    const raiReason = extractRaiFilterReason(parsed.response);
    if (raiReason) {
      this.logger.warn(`Veo RAI filter rejected the generation: ${raiReason}`);
      return {
        done: true,
        status: 'error',
        message:
          'מסנני הבטיחות של Veo דחו את הבקשה. נסו לשנות את התיאור או את התמונה. (Veo blocked the generation for safety reasons.)',
      };
    }

    /* Walk the response tree for the video URI — see walkForUri's
     * doc-comment for the rationale (Veo's response shape has drifted
     * across releases and we want to be robust to the next drift). */
    const videoUri = walkForUri(parsed.response, looksLikeVideoUri);
    const posterUri = walkForUri(parsed.response, looksLikePosterUri) ?? undefined;

    if (!videoUri) {
      /* Dump the FULL response (truncated to 5000 chars only as a
       * sanity cap) so future "no URI" reports can be debugged
       * directly from the log — pasting just a 500-char prefix loses
       * the actual video field every time it lives mid-response. */
      const dump = JSON.stringify(parsed.response ?? parsed).slice(0, 5000);
      this.logger.warn(`Veo done with no extractable video URI. Response: ${dump}`);
      return {
        done: true,
        status: 'error',
        message: 'Veo finished but returned no video URL',
      };
    }

    return { done: true, status: 'success', videoUri, posterUri };
  }

  /* Download bytes from a Veo signed URL. We hold them in memory
   * briefly (typical 8s video = ~3-8MB) on the way to a Storage
   * upload — cheaper than streaming through a pipe for files this
   * small. */
  async download(
    url: string,
  ): Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; reason: string }> {
    /* Veo's videoUri requires the API key to be appended as a query
     * param OR sent in the x-goog-api-key header — without it the
     * download returns 401. Use the header (cleaner; doesn't pollute
     * the URL we might log). */
    const apiKey = this.config.require('GEMINI_API_KEY');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'x-goog-api-key': apiKey },
      });
      if (!response.ok) {
        return { ok: false, reason: `download_non_ok_${response.status}` };
      }
      const contentType = response.headers.get('content-type') ?? 'video/mp4';
      const arrayBuffer = await response.arrayBuffer();
      return { ok: true, bytes: new Uint8Array(arrayBuffer), contentType };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        reason: isAbort ? 'download_timeout' : 'download_failed',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postJson(
    url: string,
    apiKey: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ ok: true; parsed: any } | { ok: false; reason: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let parsed: any = null;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      parsed = await response.json();
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        reason: isAbort ? 'veo_submit_timeout' : 'veo_submit_failed',
      };
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const message =
        (parsed?.error?.message as string | undefined) ??
        `veo_non_ok_${response.status}`;
      return { ok: false, reason: message };
    }
    return { ok: true, parsed };
  }
}
