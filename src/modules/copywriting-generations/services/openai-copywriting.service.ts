import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/config.service';

// Thin wrapper around GPT-4o for a single copywriting variant call.
// Mirrors ScoringService's raw-fetch pattern (no SDK), but tuned for
// text-only JSON-mode generation: no vision, larger max_tokens budget
// for the ad body + metadata, slightly higher temperature for creative
// variety across variants.
//
// Why not the openai npm package:
//   The rest of the backend uses raw fetch (scoring + dispatcher).
//   Adding a heavyweight SDK for one more chat-completion call buys us
//   nothing here and bloats the cold-start. Same headers, same JSON
//   body, same error model.
//
// Returns a structured success/failure result so callers (dispatcher,
// retry layer) can decide what to do without re-parsing the response.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o';
const TIMEOUT_MS = 30_000;
// 1200 token output budget covers a long Facebook post (~200 words ≈
// 600 tokens) plus the metadata fields with comfortable headroom. If
// the model truncates we'll see it in the finish_reason logging.
const MAX_TOKENS = 1200;
// 0.9 ≈ enough creative spread to keep AIDA-AIDA reruns from feeling
// identical without drifting into incoherence. 1.0+ starts to hallucinate
// facts not in the brief.
const TEMPERATURE = 0.9;

export interface CopywritingVariantOutput {
  adText: string;
  tonesUsed: string[];
  keywords: string[];
  conversionScore: number;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string; refusal?: string };
    finish_reason?: string;
  }>;
}

// Coerce + sanitize what the model returned into our row shape. Any
// missing/malformed field falls back to a sane default so a single bad
// metadata field doesn't sink an otherwise usable variant.
function normalize(raw: unknown): CopywritingVariantOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const adText = typeof r.ad_text === 'string' ? r.ad_text.trim() : '';
  if (!adText) return null; // body copy is the whole point — refuse the row

  const tones = Array.isArray(r.tones_used)
    ? (r.tones_used as unknown[])
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length > 0)
        .slice(0, 5)
    : [];

  const keywords = Array.isArray(r.keywords)
    ? (r.keywords as unknown[])
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0)
        .slice(0, 8)
    : [];

  // conversion_score: accept int or numeric string, clamp to [0,100].
  // Model sometimes returns "75" instead of 75 in JSON mode.
  let score = NaN;
  if (typeof r.conversion_score === 'number') score = r.conversion_score;
  else if (typeof r.conversion_score === 'string') score = parseInt(r.conversion_score, 10);
  if (!Number.isFinite(score)) score = 50; // neutral fallback rather than failing
  score = Math.max(0, Math.min(100, Math.round(score)));

  return { adText, tonesUsed: tones, keywords, conversionScore: score };
}

export type OpenAiResult =
  | { ok: true; output: CopywritingVariantOutput }
  | { ok: false; reason: string };

// Refinement-specific tuning: refinement is structurally constrained
// (preserve facts, follow an explicit instruction) so we drop the
// temperature for sharper, more on-spec output and let it use the full
// generation budget in case the user asks for a longer version.
const REFINEMENT_TEMPERATURE = 0.5;

export type RefineResult =
  | { ok: true; refinedText: string }
  | { ok: false; reason: string };

@Injectable()
export class OpenAiCopywritingService {
  private readonly logger = new Logger(OpenAiCopywritingService.name);

  constructor(private readonly config: AppConfigService) {}

  async generate(system: string, user: string): Promise<OpenAiResult> {
    const raw = await this.callJsonMode(system, user, MAX_TOKENS, TEMPERATURE);
    if (!raw.ok) return raw;

    const normalized = normalize(raw.parsed);
    if (!normalized) {
      this.logger.warn(`Unparseable generate shape: ${JSON.stringify(raw.parsed).slice(0, 500)}`);
      return { ok: false, reason: 'unparseable_shape' };
    }
    return { ok: true, output: normalized };
  }

  // Refinement: caller provides {system, user} via CopywritingPromptService;
  // we return just the refined text string. Keeping the wrapper here (vs
  // exposing callJsonMode publicly) means callers can't accidentally
  // forget to validate the shape — every public method on this service
  // returns a fully-normalized output.
  async refine(system: string, user: string): Promise<RefineResult> {
    const raw = await this.callJsonMode(system, user, MAX_TOKENS, REFINEMENT_TEMPERATURE);
    if (!raw.ok) return raw;

    const parsed = raw.parsed as Record<string, unknown> | null;
    const text = typeof parsed?.refined_text === 'string' ? parsed.refined_text.trim() : '';
    if (!text) {
      this.logger.warn(`Unparseable refine shape: ${JSON.stringify(parsed).slice(0, 500)}`);
      return { ok: false, reason: 'unparseable_shape' };
    }
    return { ok: true, refinedText: text };
  }

  // Shared transport for JSON-mode chat completions. Returns the raw
  // parsed JSON body OR a structured failure reason; callers cast the
  // parsed shape to whatever schema they expect.
  private async callJsonMode(
    system: string,
    user: string,
    maxTokens: number,
    temperature: number,
  ): Promise<
    | { ok: true; parsed: unknown }
    | { ok: false; reason: string }
  > {
    const apiKey = this.config.require('OPENAI_API_KEY');

    const payload = {
      model: MODEL,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    let body: OpenAiChatResponse | null = null;
    try {
      response = await fetch(OPENAI_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      body = (await response.json()) as OpenAiChatResponse;
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return { ok: false, reason: isAbort ? 'openai_timeout' : 'openai_call_failed' };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.logger.warn(`OpenAI non-ok ${response.status}: ${JSON.stringify(body)}`);
      return { ok: false, reason: `openai_non_ok_${response.status}` };
    }

    const choice = body?.choices?.[0];
    if (choice?.message?.refusal) {
      this.logger.warn(`OpenAI refused: ${choice.message.refusal}`);
      return { ok: false, reason: 'refusal' };
    }

    const content = choice?.message?.content;
    if (!content || typeof content !== 'string') {
      this.logger.warn(
        `No content (finish_reason=${choice?.finish_reason}): ${JSON.stringify(body)}`,
      );
      return { ok: false, reason: 'no_content' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }

    return { ok: true, parsed };
  }
}
