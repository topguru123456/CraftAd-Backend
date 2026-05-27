import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/config.service';

/* GPT-4o avatar-details generator (Hebrew JSON mode).
 *
 * Step 1 of the two-step avatar pipeline (handoff doc §8.2). Reads a
 * brand's identity (name, description, colors, tone, values) and
 * returns a structured Hebrew persona that AvatarsService persists
 * AND hands to GeminiPortraitService for the portrait image.
 *
 * Raw transport pattern mirrors OpenAiCopywritingService — no SDK,
 * same headers, same timeout shape. The chat-completions endpoint
 * with `response_format: { type: 'json_object' }` is the cheapest
 * way to get the schema-conforming output the avatars table expects
 * without dragging in OpenAI's structured-output beta surface. */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o';
const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 900;
// 0.8 — enough variety so two avatars from the same brand don't read
// identical, but tight enough that the structured fields stay coherent.
const TEMPERATURE = 0.8;

const SYSTEM_PROMPT = `You are tasked with generating a complete Brand Avatar profile in Hebrew based on the brand information provided below. Use the brand's tone, values, audience, and color identity to infer the most suitable characteristics for the avatar. Respond ONLY in JSON, following exactly the schema defined in the response_format.

When generating the avatar:
- Choose a Gender that matches the brand personality and target buyers.
- Choose a Title that logically represents the avatar's role or identity.
- Provide a realistic Age-Range.
- Identify the Target audience in one clear word (max 25 chars).
- Provide 3-4 Interests matching lifestyle/behavior/triggers.
- Provide Pains (frustrations/challenges) the brand helps solve.
- Provide Dreams-Goals reflecting deeper motivations.
- Add More-details: behavioral traits, emotional tendencies, background insights.

All fields MUST be in Hebrew. Each field concise, meaningful, brand-aligned.

Response JSON shape (use exactly these keys):
{
  "title": "<role/identity in Hebrew>",
  "gender": "<זכר | נקבה | זכר ונקבה>",
  "age_min": <int>,
  "age_max": <int>,
  "target_audience": "<one Hebrew word, max 25 chars>",
  "interests": ["<3-4 Hebrew strings>"],
  "pains": ["<Hebrew strings>"],
  "dreams_goals": ["<Hebrew strings>"],
  "more_details": "<short Hebrew paragraph>"
}`;

export interface AvatarBrandInput {
  name: string;
  description: string;
  primaryColor?: string | null;
  secondaryColors: string[];
  tone?: string | null;
  values: string[];
}

export interface AvatarDetails {
  title: string;
  gender: string;
  ageMin: number;
  ageMax: number;
  targetAudience: string;
  interests: string[];
  pains: string[];
  dreamsGoals: string[];
  moreDetails: string;
}

export type AvatarDetailsResult =
  | { ok: true; details: AvatarDetails; rawBlob: unknown }
  | { ok: false; reason: string };

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string; refusal?: string };
    finish_reason?: string;
  }>;
}

@Injectable()
export class OpenAiAvatarService {
  private readonly logger = new Logger(OpenAiAvatarService.name);

  constructor(private readonly config: AppConfigService) {}

  async generateDetails(brand: AvatarBrandInput): Promise<AvatarDetailsResult> {
    const apiKey = this.config.require('OPENAI_API_KEY');
    const userPrompt = buildUserPrompt(brand);

    const payload = {
      model: MODEL,
      response_format: { type: 'json_object' },
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
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
      this.logger.warn(`OpenAI non-ok ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
      return { ok: false, reason: `openai_non_ok_${response.status}` };
    }

    const choice = body?.choices?.[0];
    if (choice?.message?.refusal) {
      this.logger.warn(`OpenAI refused: ${choice.message.refusal}`);
      return { ok: false, reason: 'refusal' };
    }

    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content) {
      return { ok: false, reason: 'no_content' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }

    const details = normalize(parsed);
    if (!details) {
      this.logger.warn(`Unparseable avatar shape: ${JSON.stringify(parsed).slice(0, 400)}`);
      return { ok: false, reason: 'unparseable_shape' };
    }
    return { ok: true, details, rawBlob: parsed };
  }
}

function buildUserPrompt(brand: AvatarBrandInput): string {
  const lines: string[] = ['Brand Input:'];
  lines.push(`Brand Name: ${brand.name}`);
  if (brand.description) lines.push(`Brand Description: ${brand.description}`);
  const palette = [brand.primaryColor, ...brand.secondaryColors].filter(Boolean);
  if (palette.length > 0) lines.push(`Brand Colors: ${palette.join(', ')}`);
  if (brand.tone) lines.push(`Brand Tone: ${brand.tone}`);
  if (brand.values.length > 0) lines.push(`Brand Values: ${brand.values.join(', ')}`);
  return lines.join('\n');
}

function normalize(raw: unknown): AvatarDetails | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const title = pickString(r.title);
  const gender = pickString(r.gender);
  const targetAudience = clampWord(pickString(r.target_audience), 25);
  const moreDetails = pickString(r.more_details);

  const ageMin = pickInt(r.age_min);
  const ageMax = pickInt(r.age_max);

  const interests = pickStringArray(r.interests, 6);
  const pains = pickStringArray(r.pains, 6);
  const dreamsGoals = pickStringArray(r.dreams_goals, 6);

  // Hard requirement: every persona must at least have a title + audience
  // descriptor. Without these the row is meaningless; surfacing the
  // partial would clutter the user's grid with empty cards.
  if (!title || !targetAudience) return null;

  return {
    title,
    gender,
    ageMin,
    ageMax,
    targetAudience,
    interests,
    pains,
    dreamsGoals,
    moreDetails,
  };
}

function pickString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function pickInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function pickStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0)
    .slice(0, max);
}

// The doc constraint is "one Hebrew word, ≤25 chars". The model
// occasionally returns a 2-3 word phrase even with the instruction;
// take the first word and length-cap. Cleaner than failing the row.
function clampWord(v: string, max: number): string {
  const firstWord = v.split(/\s+/u)[0] ?? '';
  return firstWord.slice(0, max);
}
