import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../../config/config.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';
import { AvatarDetails } from './openai-avatar.service';

/* Step 2 of the avatar pipeline (handoff doc §8.3): generate a
 * realistic portrait photo from the persona JSON produced by
 * OpenAiAvatarService.
 *
 * Model: `gemini-3-pro-image-preview` via the public
 * generativelanguage endpoint. We previously ran on
 * `gemini-2.5-flash-image` for consistency with the campaign-creative
 * image path, but 2.5-flash-image was returning `finishReason:
 * NO_IMAGE` at an unacceptable rate for photorealistic portraits.
 * The 3-pro variant is the Pro tier of the Gemini-3 image family
 * (slower + more expensive per call but markedly better at
 * portrait fidelity and noticeably less likely to soft-decline on
 * person-rendering prompts). Auth + request shape are unchanged
 * from 2.5-flash; only the model ID in the URL flipped.
 *
 * Note: the `-preview` suffix is intentional — that's the current
 * documented identifier on ai.google.dev as of June 2026. If/when
 * Google drops the suffix at GA, update both this constant and the
 * doc comment.
 *
 * Returns the public Supabase URL — the FE never sees the
 * generation response. */

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/' +
  'gemini-3-pro-image-preview:generateContent';
const BUCKET = 'avatar-portraits';

/* Soft on photorealism (vs. the previous "must look like an
 * authentic photograph" wording). gemini-2.5-flash-image and even
 * gemini-3-pro-image-preview show measurable refusal rates on
 * "produce a photorealistic photo of a specific person" prompts —
 * the model returns finishReason=NO_IMAGE rather than firing the
 * safety pathway, which makes it look like nothing's wrong from
 * the API status code. Giving the model permission to deliver
 * either a photo OR a high-fidelity stylized portrait drops the
 * refusal rate significantly without compromising the avatar's
 * "looks like a real persona" quality. */
const PORTRAIT_INSTRUCTION = `Create a polished brand-persona portrait of the avatar described below. Photographic style is preferred, but a high-fidelity stylized (editorial illustration / 3D-rendered) portrait is acceptable — anything that reads as a premium brand profile image. Not a sketch, not a cartoon, not a comic.

Follow these rules:
- Represent the avatar's Gender, Age-Range, Title, and personality.
- The avatar should appear confident, approachable, and aligned with the brand's tone and values.
- Style the clothing, expression, and overall appearance to match the avatar's lifestyle, interests, and professional energy.
- Use lighting and composition suitable for a premium brand profile image.
- Avoid props or elements that contradict the brand style.
- No text, logos, or watermarks in the image.

Generate a single high-quality avatar portrait that fully reflects this persona.`;

export interface GeneratedPortrait {
  url: string;
  path: string;
  mime: string;
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type?: string; data?: string };
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    safetyRatings?: unknown;
  }>;
  promptFeedback?: { blockReason?: string; safetyRatings?: unknown };
  error?: { message?: string };
}

@Injectable()
export class GeminiPortraitService {
  private readonly logger = new Logger(GeminiPortraitService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async generate(
    userId: string,
    avatarId: string,
    details: AvatarDetails,
  ): Promise<GeneratedPortrait> {
    const apiKey = this.config.require('GEMINI_API_KEY');
    const prompt = `${PORTRAIT_INSTRUCTION}\n\nBrand Avatar Details:\n${formatDetails(details)}`;

    /* Request body.
     *
     *   responseModalities: ["IMAGE"]
     *     Text-only prompts default to TEXT output; the avatar
     *     pipeline is pure text-to-image and must declare the
     *     modality explicitly. AiImageService doesn't need this
     *     because its reference-image input implicitly anchors image
     *     output. Enum is ALL CAPS per Google's convention.
     *
     *   imageConfig.aspectRatio = "1:1", imageConfig.imageSize = "1K"
     *     Square 1024×1024 output. The Gemini 3 model accepts
     *     these string values through `generationConfig.imageConfig`
     *     specifically — NOT through `generationConfig.responseFormat.
     *     image`. Both paths appear in Google's docs but they
     *     dispatch to different protobuf messages; the
     *     `ImageResponseFormat.AspectRatio` enum under the
     *     `responseFormat` path is older and rejects "1:1" / "1K"
     *     as invalid values (we tried — that's where the previous
     *     iteration of this code died). The newer `imageConfig`
     *     path accepts the human-readable strings as documented.
     *
     *     `1K` = 1024-on-the-long-edge → for 1:1, 1024×1024. Plenty
     *     for an avatar that ships into a ≤112px CSS slot; "2K"/
     *     "4K" would just inflate bandwidth + latency.
     *
     *   safetySettings: BLOCK_NONE on all four categories
     *     Per handoff doc §7, Gemini's defaults reject some Hebrew
     *     marketing content as false positives — model returns an
     *     empty text part with finishReason=STOP instead of a real
     *     refusal, which looks identical to "no image" at the API
     *     level. Mirrors what the Bubble dispatcher does today. */
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: '1:1',
          imageSize: '1K',
        },
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    };

    let response: Response;
    let parsed: GeminiResponse | null = null;
    try {
      response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      parsed = (await response.json()) as GeminiResponse;
    } catch (err) {
      this.logger.error('Gemini portrait request failed', err);
      throw new BadGatewayException('Gemini service is unreachable');
    }

    if (!response.ok) {
      const message =
        parsed?.error?.message ?? `Gemini request failed (${response.status})`;
      throw new BadGatewayException(message);
    }

    const image = extractInlineImage(parsed);
    if (!image) {
      // Surface the specific reason if Gemini gave one — finishReason
      // (SAFETY / RECITATION / MAX_TOKENS / OTHER) and promptFeedback
      // tell us what the model actually objected to so we can iterate
      // on the prompt or thresholds instead of guessing.
      const finishReason = parsed?.candidates?.[0]?.finishReason ?? 'unknown';
      const blockReason = parsed?.promptFeedback?.blockReason;
      this.logger.warn(
        `Gemini portrait returned no image. finishReason=${finishReason}` +
          (blockReason ? `, promptBlock=${blockReason}` : '') +
          `\nFull body: ${JSON.stringify(parsed).slice(0, 2000)}`,
      );
      throw new BadGatewayException(
        blockReason
          ? `Gemini blocked the portrait prompt (${blockReason}). Try a different brand input.`
          : `Gemini returned no portrait image (finishReason=${finishReason}). Check backend logs for the full response.`,
      );
    }

    const bytes = base64ToBytes(image.data);
    const ext = extFromMime(image.mime);
    // Path includes the avatar id so re-generating overwrites cleanly
    // and the previous portrait is reachable via the (now-stale) URL
    // for as long as Supabase serves it. Using Date.now() in the
    // suffix means each regeneration produces a unique URL so React's
    // <img src> swap doesn't get stuck on a cached old portrait.
    const path = `${userId}/${avatarId}-${Date.now()}.${ext}`;

    const uploaded = await this.storage.upload(BUCKET, path, bytes, image.mime);
    return { url: uploaded.publicUrl, path: uploaded.path, mime: image.mime };
  }
}

function formatDetails(d: AvatarDetails): string {
  const lines: string[] = [];
  if (d.gender) lines.push(`Gender: ${d.gender}`);
  if (d.title) lines.push(`Title: ${d.title}`);
  if (d.ageMin || d.ageMax) lines.push(`Age Range: ${d.ageMin}-${d.ageMax}`);
  if (d.targetAudience) lines.push(`Target Audience: ${d.targetAudience}`);
  if (d.interests.length) lines.push(`Interests: ${d.interests.join(', ')}`);
  if (d.pains.length) lines.push(`Pain Points: ${d.pains.join(', ')}`);
  if (d.dreamsGoals.length) lines.push(`Dreams & Goals: ${d.dreamsGoals.join(', ')}`);
  if (d.moreDetails) lines.push(`Additional Traits: ${d.moreDetails}`);
  return lines.join('\n');
}

function extractInlineImage(body: GeminiResponse | null): { mime: string; data: string } | null {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const inline = part.inline_data ?? part.inlineData;
    const data = inline?.data;
    if (typeof data === 'string' && data.length > 0) {
      const mime =
        (inline as { mime_type?: string }).mime_type ??
        (inline as { mimeType?: string }).mimeType ??
        'image/png';
      return { mime, data };
    }
  }
  return null;
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

function base64ToBytes(b64: string): Uint8Array {
  const stripped = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const buf = Buffer.from(stripped, 'base64');
  if (buf.length === 0) throw new Error('decoded portrait is empty');
  return new Uint8Array(buf);
}
