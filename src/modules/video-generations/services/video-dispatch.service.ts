import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Brand,
  Project,
  GenerationStatus,
  VideoGeneration,
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { VeoApiService, VeoAspectRatio } from './veo-api.service';
import { VideoPromptService } from './video-prompt.service';

/* Wizard ratio id → Veo aspect_ratio. The Veo 3 Gemini API accepts
 * ONLY 9:16 and 16:9 (1:1 and 4:5 are rejected — "aspectRatio does
 * not support '1:1'"). The video wizard restricts the picker to
 * landscape + story; the other ids are kept as defensive coercions
 * for any legacy rows that predate the restriction so an older
 * project doesn't 400 on re-dispatch. Square and portrait fall back
 * to 9:16 (story) — the closest portrait-friendly Veo-supported
 * shape — rather than dropping the request entirely. */
const RATIO_MAP: Record<string, VeoAspectRatio> = {
  landscape: '16:9',
  story: '9:16',
  square: '9:16',
  portrait: '9:16',
  '1:1': '9:16',
  '9:16': '9:16',
  '16:9': '16:9',
  '4:5': '9:16',
};

const VIDEO_DURATION_SECONDS = 8;
/* Cap the in-flight image reference at ~20MB. Veo's docs are silent
 * on the exact limit; this is generous for typical product photos
 * and keeps the base64 round-trip from blowing past Node's default
 * fetch buffers. */
const REFERENCE_FETCH_TIMEOUT_MS = 15_000;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

/* Orchestrates a video-creative dispatch click — DIRECT against Veo
 * 3 via the Gemini API. No GCF, no webhook.
 *
 *   1. Load project + brand (user-scoped; 404 if not theirs).
 *   2. Resolve aspect_ratio, mode, and (for image-mode) the product
 *      reference URL → fetch its bytes server-side.
 *   3. Build the prompt via VideoPromptService.
 *   4. Reserve a pending row (with all inputs) BEFORE the Veo
 *      submit so the row exists even if Veo fails — we update it
 *      to `failed` rather than losing the attempt entirely.
 *   5. Submit to Veo. Store the returned operation name on the row,
 *      flip to `dispatched`.
 *   6. Return immediately. Veo's long-running operation completes
 *      in 1-3min on Google's side; VeoPollService picks it up on
 *      the next list/get call (driven by the FE's 10s poll on
 *      useVideoVariants).
 *
 * Why no fan-out (single dispatch per click):
 *   Veo 3 is ~10-20× the per-unit cost of image gen and ~5× the
 *   wall-clock time. Users iterate on ONE video at a time — the
 *   "3 variants" UX that works for cheap fast image gen would be
 *   punitive here.
 */
@Injectable()
export class VideoDispatchService {
  private readonly logger = new Logger(VideoDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: VideoPromptService,
    private readonly veo: VeoApiService,
  ) {}

  async dispatch(
    userId: string,
    _userEmail: string,
    projectId: string,
  ): Promise<Pick<VideoGeneration, 'id' | 'projectId' | 'status'>> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const brand = await this.prisma.brand.findFirst({
      where: { id: project.brandId, userId },
    });
    if (!brand) throw new NotFoundException('מותג לא נמצא');

    const { aspectRatio, mode, referenceImageUrl } = this.resolveDispatchInputs(
      project,
      brand,
    );

    const prompt = this.promptService.build(
      VideoPromptService.fromProjectAndBrand(project, brand, mode),
    );

    /* Log the FULL assembled prompt at dispatch time. Without this
     * we can't tell whether a "Veo ignored my description" complaint
     * is the assembler dropping the user's text, the user typing
     * something Veo can't visualize, or a Veo-side drift. Multiline
     * is fine in Nest's logger — it pretty-prints onto its own
     * lines. Promote to `verbose` later if log volume becomes an
     * issue, but for now visibility wins. */
    this.logger.log(
      `Veo prompt (project=${projectId}, mode=${mode}, ratio=${aspectRatio}):\n${prompt}`,
    );

    /* Phase 1: reserve the row + persist all inputs. Done BEFORE
     * the Veo submit so we always have a row to update — if Veo
     * rejects (bad prompt, quota, etc.) we mark it failed and the
     * user sees the error in the result grid instead of an empty
     * void. */
    const row = await this.prisma.videoGeneration.create({
      data: {
        projectId,
        userId,
        status: GenerationStatus.pending,
        mode,
        prompt,
        referenceImageUrl: referenceImageUrl || null,
        aspectRatio,
        durationSeconds: VIDEO_DURATION_SECONDS,
      },
      select: { id: true, projectId: true, status: true },
    });

    /* Phase 2: fetch the reference image bytes inline for Veo (its
     * `image` field is base64, not a URL). Gated on
     * `referenceImageUrl` (NOT on mode) because both modes can now
     * have a reference:
     *   • image-mode: the product photo (required by resolve step)
     *   • text-mode: the brand logo (optional — absent for brands
     *                 without a logo, in which case text-only Veo call)
     * If the fetch fails in image-mode we mark the row failed because
     * the product reference is required. In text-mode a logo-fetch
     * failure is non-fatal — we log and fall back to text-only so a
     * transient CDN hiccup on the logo doesn't sink the generation. */
    let referenceBytes: Uint8Array | undefined;
    let referenceMime: string | undefined;
    if (referenceImageUrl) {
      const fetched = await this.fetchReference(referenceImageUrl);
      if (fetched.ok) {
        referenceBytes = fetched.bytes;
        referenceMime = fetched.contentType;
      } else if (mode === 'image') {
        // image-mode requires the product image — fail loud.
        await this.markFailed(row.id, fetched.reason);
        return { ...row, status: GenerationStatus.failed };
      } else {
        // text-mode logo fetch failure — best-effort; continue text-only.
        this.logger.warn(
          `text-mode logo fetch failed (${fetched.reason}); proceeding text-only`,
        );
      }
    }

    /* Phase 3: submit to Veo. Submit blocks for ~1-3s — actual
     * generation runs in the background on Google's side. We store
     * the operation name and return; VeoPollService takes over
     * from here. */
    const submit = await this.veo.submit({
      prompt,
      referenceImageBytes: referenceBytes,
      referenceImageMime: referenceMime,
      aspectRatio,
      durationSeconds: VIDEO_DURATION_SECONDS,
    });

    if (!submit.ok) {
      await this.markFailed(row.id, submit.reason);
      return { ...row, status: GenerationStatus.failed };
    }

    return this.prisma.videoGeneration.update({
      where: { id: row.id },
      data: {
        status: GenerationStatus.dispatched,
        operationName: submit.operationName,
      },
      select: { id: true, projectId: true, status: true },
    });
  }

  private resolveDispatchInputs(
    project: Project,
    brand: Brand,
  ): {
    aspectRatio: VeoAspectRatio;
    mode: 'text' | 'image';
    referenceImageUrl: string;
  } {
    if (!project.aspectRatio) {
      throw new BadRequestException('לפרויקט חסר aspect_ratio');
    }
    const aspectRatio = RATIO_MAP[project.aspectRatio];
    if (!aspectRatio) {
      throw new BadRequestException(
        `ratio '${project.aspectRatio}' is not supported for video`,
      );
    }
    if (
      project.aspectRatio !== 'landscape' &&
      project.aspectRatio !== 'story'
    ) {
      this.logger.warn(
        `ratio '${project.aspectRatio}' coerced to ${aspectRatio} — Veo only accepts 9:16 + 16:9`,
      );
    }

    const draft = (project.draft ?? {}) as {
      videoSourceType?: unknown;
      images?: Array<{ url?: unknown }>;
    };
    const mode: 'text' | 'image' =
      draft.videoSourceType === 'image' ? 'image' : 'text';

    /* Reference image strategy (Veo accepts ONE per call):
     *   • image-mode → product reference uploaded in step 3 (required)
     *   • text-mode  → brand logo (optional; if the brand has none,
     *                  we send text-only and Veo generates without
     *                  any visual anchor — still valid)
     *
     * Picking different references per mode (rather than compositing
     * or skipping) keeps the wire shape simple AND gives each mode
     * the most relevant visual: an animated product for image-mode,
     * brand-identity-grounded for text-mode. */
    let referenceImageUrl = '';
    if (mode === 'image') {
      const raw = draft.images?.[0]?.url;
      referenceImageUrl = typeof raw === 'string' && raw ? raw : '';
      if (!referenceImageUrl) {
        throw new BadRequestException(
          'נבחר מצב תמונה-לסרטון אך לא נמצאה תמונת מוצר בפרויקט',
        );
      }
    } else {
      // text-mode: use brand logo when available; otherwise empty
      // (text-only Veo call, no required-field throw — text-mode
      // without a logo is still a valid generation). Supabase logo
      // URLs are already full https; a null/empty falls through to
      // the text-only path naturally.
      referenceImageUrl =
        typeof brand.logoUrl === 'string' ? brand.logoUrl : '';
    }

    return { aspectRatio, mode, referenceImageUrl };
  }

  /* Fetch a Supabase-hosted reference image into memory for the Veo
   * inline-bytes field. Bounded by timeout and size to keep a
   * misbehaving CDN from hanging the dispatch handler. Returns a
   * structured failure result rather than throwing so the caller
   * can persist the failure on the row instead of crashing the
   * request. */
  private async fetchReference(
    url: string,
  ): Promise<
    | { ok: true; bytes: Uint8Array; contentType: string }
    | { ok: false; reason: string }
  > {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REFERENCE_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return {
          ok: false,
          reason: `reference_fetch_non_ok_${response.status}`,
        };
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_REFERENCE_BYTES) {
        return { ok: false, reason: 'reference_image_too_large' };
      }
      const contentType =
        response.headers.get('content-type')?.split(';')[0]?.trim() ??
        'image/jpeg';
      return {
        ok: true,
        bytes: new Uint8Array(arrayBuffer),
        contentType,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        reason: isAbort ? 'reference_fetch_timeout' : 'reference_fetch_failed',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async markFailed(id: string, message: string): Promise<void> {
    await this.prisma.videoGeneration.updateMany({
      where: {
        id,
        status: {
          in: [GenerationStatus.pending, GenerationStatus.dispatched],
        },
      },
      data: {
        status: GenerationStatus.failed,
        errorMessage: message.slice(0, 1000),
      },
    });
  }
}
