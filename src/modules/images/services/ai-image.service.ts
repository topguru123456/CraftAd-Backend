import {
  BadGatewayException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AppConfigService } from '../../../config/config.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';
import { GenerateAiImageDto } from '../dto/generate-ai-image.dto';

const BUCKET = 'campaign-uploads';
/* Model: `gemini-3-pro-image-preview`. Same model the avatar pipeline
 * uses (see modules/avatars/services/gemini-portrait.service.ts) —
 * 2.5-flash-image was producing too many low-quality results on the
 * wizard's "AI-generate product image" button. The `-preview` suffix
 * is intentional: that's the current public identifier on
 * ai.google.dev. When Google drops the suffix at GA, update both this
 * constant and the matching one in the avatar service. */
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/' +
  'gemini-3-pro-image-preview:generateContent';

// Static preamble — verbatim from the prior edge function. Keeps generation
// quality consistent across the migration.
const ART_DIRECTOR_PREAMBLE =
  'You are an expert art director specializing in captivating product ' +
  'imagery. Create a photorealistic, high-resolution product image that ' +
  'is visually stunning and effective for marketing campaigns. Also ' +
  "take into account the user request. Do not ask any questions " +
  'incase of anything that is unclear complete the request to the best ' +
  'of your understanding. User request ';

export interface GeneratedImage {
  url: string;
  path: string;
  mime: string;
}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message?: string };
}

// Calls Gemini 2.5 Flash Image with prompt + reference image, uploads the
// resulting bytes to campaign-uploads/<userId>/ai-<ts>.<ext>, returns the
// public URL.
//
// The browser never sees the Gemini response — only the final Supabase URL.
// That means we don't round-trip a multi-MB base64 payload back through the
// client, and the GEMINI_API_KEY never leaves the backend.
@Injectable()
export class AiImageService {
  private readonly logger = new Logger(AiImageService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async generate(
    userId: string,
    dto: GenerateAiImageDto,
  ): Promise<GeneratedImage> {
    const apiKey = this.config.require('GEMINI_API_KEY');

    const hasReference = Boolean(
      dto.referenceImageBase64 && dto.referenceMime,
    );

    const parts: GeminiPart[] = [
      { text: `${ART_DIRECTOR_PREAMBLE}${dto.prompt.trim()}` },
    ];
    if (hasReference) {
      parts.push({
        inline_data: {
          mime_type: dto.referenceMime as string,
          data: dto.referenceImageBase64 as string,
        },
      });
    }

    /* responseModalities=['IMAGE'] is required for the text-only path:
     * without a reference image to implicitly anchor image output,
     * Gemini defaults to TEXT and returns commentary instead of bytes.
     * With a reference the modality is already image-biased but
     * declaring it explicitly costs nothing and removes the implicit
     * dependency on input shape. */
    const geminiBody = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    };

    let response: Response;
    let body: GeminiResponse | null = null;
    try {
      response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(geminiBody),
      });
      body = (await response.json()) as GeminiResponse;
    } catch (err) {
      this.logger.error('Gemini request failed', err);
      throw new BadGatewayException('Gemini service is unreachable');
    }

    if (!response.ok) {
      const message = body?.error?.message ?? `Gemini request failed (${response.status})`;
      throw new BadGatewayException(message);
    }

    const generated = this.extractImage(body);
    if (!generated) {
      this.logger.warn('No inline_data in Gemini response', body);
      throw new BadGatewayException(
        'Gemini did not return an image. The prompt may have been ' +
          'rejected by safety filters — try rephrasing.',
      );
    }

    const bytes = base64ToBytes(generated.data);
    const ext = extFromMime(generated.mime);
    const path = `${userId}/ai-${Date.now()}.${ext}`;

    const uploaded = await this.storage.upload(BUCKET, path, bytes, generated.mime);
    return { url: uploaded.publicUrl, path: uploaded.path, mime: generated.mime };
  }

  // Walk candidates for the first part with inline_data bytes. Gemini
  // occasionally intermixes text parts (commentary); we want only the image.
  private extractImage(body: GeminiResponse | null): { mime: string; data: string } | null {
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
  if (buf.length === 0) throw new Error('decoded reference image is empty');
  return new Uint8Array(buf);
}
