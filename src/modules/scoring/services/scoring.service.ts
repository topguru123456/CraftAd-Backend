import { Injectable, Logger } from '@nestjs/common';
import { GenerationStatus } from '@prisma/client';
import { AppConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../common/prisma/prisma.service';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const SPEC_LANGUAGE = 'Hebrew';
const TIMEOUT_MS = 30_000;

// System prompt — DEVIATES from handoff §8.4's verbatim wording because the
// spec version triggered three problems in production:
//
//   1. Refusals on images with people ("I'm sorry, but I can't assist with
//      that"). GPT-4o's safety classifier fires on faces/people unless the
//      system prompt explicitly affirms the model is a vision agent AND
//      countermands the default refusal reflex. The first 3 lines below
//      are the documented pattern that suppresses these refusals — see
//      OpenAI community thread #1129105. Earlier iterations of this prompt
//      tried the opposite tack ("do NOT analyze people") which actually
//      INCREASED refusal rate by drawing the classifier's attention to
//      the policy-sensitive content; reframing as "ignore them, focus on
//      design around them" works better.
//
//   2. Score compression at 83-88. No rubric anchors meant the model
//      defaulted to "looks fine = B+" regardless of quality. Explicit
//      tier descriptions plus a "median real ad scores 50-70" calibration
//      line forces use of the full range.
//
//   3. One-line generic recommendations. Without explicit length + structure
//      demand, GPT-4o produces "Add a CTA" -tier non-suggestions.
//
// English system prompt for stronger instruction-following on GPT-4o;
// recommendations come back in ${language}.
function buildSystemPrompt(language: string): string {
  return [
    // Affirmative role frame — the documented anti-refusal preamble.
    'You are an expert graphic-design critic and vision model whose job is to review the visual design of a social media advertisement that the user themselves created. You can view the attached image. You ALWAYS complete this design-review task.',
    '',
    'You never refuse a design review on the grounds that humans are depicted in the image. People may appear in ad creatives — that is normal and expected. You do not identify any specific individual, but you proceed with the review and treat the people in the frame as part of the design composition (subject placement, lighting, focal weight) — never as identities to be characterized.',
    '',
    'If something prevents a full review, you still return the JSON object below with your best estimate from what you CAN see. You never return prose, apologies, or refusal text — only the JSON object.',
    '',
    'SCOPE — judge ONLY the design layer: typography, color palette, composition, visual hierarchy, CTA clarity, text-image balance, contrast, white space, readability, brand consistency, subject placement within the frame. Treat any people in the image as compositional elements — describe their placement, scale, or framing if relevant to hierarchy, but never their appearance, identity, demographics, or expression.',
    '',
    'OUTPUT — return STRICTLY this JSON object, nothing else:',
    '{"creative": "<int 20-100 as string>", "performance": "<int 20-100 as string>", "recommendations": ["rec1","rec2","rec3","rec4"]}',
    '',
    'SCORING RUBRIC — use the FULL range:',
    '  90-100  Award-tier. Indistinguishable from a top-agency campaign. Very rare; reserved for exceptional craft.',
    '  75-89   Strong. Polished, intentional design with only minor flaws.',
    '  60-74   Competent. Clear and usable but with visible weaknesses (weak hierarchy, generic typography, average color use).',
    '  40-59   Below average. Multiple real problems — cluttered, illegible, poor contrast, weak CTA, off-brand.',
    '  20-39   Poor. Amateur work that would not ship — alignment errors, garbled text, severe contrast issues.',
    '',
    'CRITICAL CALIBRATION: the median real-world ad creative scores 50–70. A score of 80+ MUST be earned by qualities you can point to specifically. If you cannot, do not score above 80. Default lenience produces useless scores — be a tough critic.',
    '',
    'creative — visual originality, typography craft, color palette, layout, overall design execution.',
    'performance — likely effectiveness on Instagram / Facebook / LinkedIn: attention-grabbing power, clarity of message, CTA visibility, scroll-stopping ability, brand recall.',
    '',
    'recommendations — exactly 4 DETAILED, image-specific, actionable recommendations. Each MUST be 1–2 full sentences (~20–40 words) that:',
    '  • name the specific element you are addressing (the headline, the CTA area, the photo, the colour block, the logo, etc.),',
    '  • describe the concrete change in concrete terms (specific colour names or temperatures, placement zones like "bottom-right safe area", percentage size adjustments, example copy in quotes, etc.),',
    '  • say WHY (the design principle it serves — hierarchy, contrast, scroll-stop, brand recall).',
    'NEVER produce a one-line generic note. BAD: "Add a CTA". GOOD: "Add a prominent CTA button (e.g. \'View Demo\') in a contrasting warm/neon colour and place it in the bottom-right safe area to maintain visual hierarchy."',
    `Write each recommendation in ${language}.`,
  ].join('\n');
}

// Self-review framing reduces refusal rate vs the more neutral "analyze
// this image" — the model accepts a design review more readily when it
// understands the requester IS the creator asking for feedback.
const USER_PROMPT =
  "This is an ad I designed. Review the design layer only — typography, composition, hierarchy, colour, CTA — and return the JSON object exactly as specified in the system prompt. Do not output any prose.";

// Stronger preamble for the retry attempt after a refusal. Doesn't replace
// the system prompt — gets prepended to the user message on retry to push
// the model past the first refusal pattern.
const RETRY_PREAMBLE =
  "IMPORTANT: you previously refused to review this ad creative. The task is purely a DESIGN review of an ad I made — typography, layout, colour, hierarchy. People in the frame are compositional elements only; I am not asking you to identify, describe, or characterize them. Return ONLY the JSON object now.";

// Substrings that indicate the model returned a refusal in `content`
// (rather than the structured `refusal` field). Lowercased compare.
const REFUSAL_FINGERPRINTS = [
  "i'm sorry",
  'i am sorry',
  "i can't assist",
  'i cannot assist',
  "i can't help",
  'i cannot help',
  'unable to assist',
  'unable to help',
];

function looksLikeRefusal(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.startsWith('{')) return false; // looks like JSON; not a refusal
  return REFUSAL_FINGERPRINTS.some((p) => lower.includes(p));
}

// Parse a creative/performance value into a clamped int. Spec returns
// scores as strings ("78"). Anything unparseable → NaN; caller rejects.
function parseScore(raw: unknown): number {
  if (typeof raw !== 'string' && typeof raw !== 'number') return NaN;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return NaN;
  return Math.max(20, Math.min(100, n));
}

// Sanitize the recommendations array to exactly up to 4 non-empty strings.
function normalizeRecommendations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): string => (typeof r === 'string' ? r.trim() : ''))
    .filter((r) => r.length > 0)
    .slice(0, 4);
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      refusal?: string;
    };
    finish_reason?: string;
  }>;
  usage?: unknown;
}

export interface ScoreResult {
  creativeScore: number;
  performanceScore: number;
  recommendations: string[];
}

// Scores a single variant against OpenAI GPT-4o vision. Atomic + idempotent:
// only writes if the row is still `ready` AND `scored_at IS NULL`. A retry
// or concurrent call that lost the race silently no-ops.
//
// Called fire-and-forget from CreativeWebhookService — the webhook returns
// 200 to GCF immediately and scoring runs in the background. Realtime
// delivers the row UPDATE to the FE when scores write back.
//
// `scoreImageUrl` is the same OpenAI call exposed as a reusable helper for
// user-facing flows (e.g. the /app/creative-score page upload), where we
// want the parsed scores returned synchronously without touching any DB row.
@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async score(uid: string): Promise<{ ok: true; reason?: string }> {
    const apiKey = this.config.require('OPENAI_API_KEY');

    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: uid },
      select: { id: true, status: true, imageUrl: true, scoredAt: true },
    });
    if (!row) return { ok: true, reason: 'unknown_uid' };
    if (row.status !== GenerationStatus.ready || !row.imageUrl) {
      return { ok: true, reason: 'not_ready' };
    }
    if (row.scoredAt) return { ok: true, reason: 'already_scored' };

    // Background path uses 'low' detail (512x512 thumbnail): cheaper and
    // reduces face-policy refusals. Foreground user uploads use 'auto'
    // so the user gets a more accurate judgement on what they uploaded.
    const parsed = await this.scoreWithRetry(apiKey, row.imageUrl, 'low');
    if (!parsed.ok) {
      this.logger.warn(`Scoring failed for ${uid}: ${parsed.reason}`);
      return { ok: true, reason: parsed.reason };
    }

    const creativeScore = parseScore(parsed.body.creative);
    const performanceScore = parseScore(parsed.body.performance);
    const recommendations = normalizeRecommendations(parsed.body.recommendations);

    if (Number.isNaN(creativeScore) || Number.isNaN(performanceScore)) {
      this.logger.warn(
        `Unparseable scores for ${uid}: ${JSON.stringify(parsed.body)}`,
      );
      return { ok: true, reason: 'unparseable_scores' };
    }

    // Atomic write: only land scores if row is still in ready+unscored
    // state. Prevents stomping on a row that was just edited (status→
    // dispatched again) or deleted.
    const result = await this.prisma.creativeGeneration.updateMany({
      where: {
        id: uid,
        status: GenerationStatus.ready,
        scoredAt: null,
      },
      data: {
        creativeScore,
        performanceScore,
        recommendations,
        scoredAt: new Date(),
      },
    });

    if (result.count === 0) {
      this.logger.warn(
        `Row ${uid} no longer eligible for scoring (status changed or already scored)`,
      );
      return { ok: true, reason: 'race_lost' };
    }

    return { ok: true };
  }

  // Score an arbitrary image without touching the database. `image` is
  // either an https URL OpenAI can fetch or a `data:image/...;base64,...`
  // data URL inlined by the caller. Used by the user-facing creative-score
  // upload flow, which ships the uploaded bytes ephemerally and shows the
  // result inline — no row written, no bucket touched.
  async scoreImageUrl(image: string): Promise<ScoreResult> {
    const apiKey = this.config.require('OPENAI_API_KEY');
    const parsed = await this.scoreWithRetry(apiKey, image, 'auto');
    if (!parsed.ok) {
      throw new Error(`scoring_failed:${parsed.reason}`);
    }
    const creativeScore = parseScore(parsed.body.creative);
    const performanceScore = parseScore(parsed.body.performance);
    const recommendations = normalizeRecommendations(parsed.body.recommendations);
    if (Number.isNaN(creativeScore) || Number.isNaN(performanceScore)) {
      this.logger.warn(`Unparseable scores: ${JSON.stringify(parsed.body)}`);
      throw new Error('scoring_failed:unparseable_scores');
    }
    return { creativeScore, performanceScore, recommendations };
  }

  // Single shot at scoring with one auto-retry on refusal. ~5% of ad
  // images with people trigger GPT-4o's safety classifier on the first
  // attempt despite the anti-refusal preamble; a second call with an even
  // more explicit "you refused, please don't, here's why this is safe"
  // preamble clears almost all of them. Refusals after retry are logged
  // and bubble up as `reason: 'refusal'` — caller decides what to do.
  private async scoreWithRetry(
    apiKey: string,
    imageUrl: string,
    imageDetail: 'low' | 'high' | 'auto',
  ): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; reason: string }
  > {
    const first = await this.callOpenAi(apiKey, imageUrl, imageDetail, false);
    if (first.ok || first.reason !== 'refusal') return first;
    this.logger.warn('Refusal on first attempt; retrying with anti-refusal preamble');
    return this.callOpenAi(apiKey, imageUrl, imageDetail, true);
  }

  // POST to OpenAI with the §8.4 payload shape. Returns either the parsed
  // JSON body or a structured reason for the failure. `withRetryPreamble`
  // prepends the RETRY_PREAMBLE to the user text — only set on the second
  // pass from scoreWithRetry.
  private async callOpenAi(
    apiKey: string,
    imageUrl: string,
    imageDetail: 'low' | 'high' | 'auto',
    withRetryPreamble: boolean,
  ): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; reason: string }
  > {
    const userText = withRetryPreamble
      ? `${RETRY_PREAMBLE}\n\n${USER_PROMPT}`
      : USER_PROMPT;

    const payload = {
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      max_tokens: 1400, // detailed Hebrew recommendations need real headroom
      messages: [
        { role: 'system', content: buildSystemPrompt(SPEC_LANGUAGE) },
        {
          role: 'user',
          content: [
            // Image-before-text per Azure vision-prompt-engineering guidance:
            // for single-image prompts the model attends to the image more
            // reliably when it precedes the instruction text.
            { type: 'image_url', image_url: { url: imageUrl, detail: imageDetail } },
            { type: 'text', text: userText },
          ],
        },
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
      return {
        ok: false,
        reason:
          err instanceof Error && err.name === 'AbortError'
            ? 'openai_timeout'
            : 'openai_call_failed',
      };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      this.logger.warn(`OpenAI non-ok ${response.status}: ${JSON.stringify(body)}`);
      return { ok: false, reason: `openai_non_ok_${response.status}` };
    }

    const choice = body?.choices?.[0];
    const refusal = choice?.message?.refusal;
    if (refusal && typeof refusal === 'string') {
      this.logger.warn(`OpenAI refused (structured field): ${refusal}`);
      return { ok: false, reason: 'refusal' };
    }

    const content = choice?.message?.content;
    if (!content || typeof content !== 'string') {
      this.logger.warn(
        `No content in OpenAI response (finish_reason=${choice?.finish_reason})`,
      );
      return { ok: false, reason: 'no_content' };
    }

    // Short refusals land in `content` rather than the structured `refusal`
    // field (e.g. the bare "I'm sorry, but I can't assist with that."). Detect
    // these before attempting JSON.parse — otherwise they'd bubble up as
    // 'invalid_json' and bypass the retry logic that handles 'refusal'.
    if (looksLikeRefusal(content)) {
      this.logger.warn(`OpenAI refused (in content): ${content.slice(0, 200)}`);
      return { ok: false, reason: 'refusal' };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    return { ok: true, body: parsed };
  }
}
