import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EditStatus, GenerationStatus } from '@prisma/client';
import { AppConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';

const CREATIVES_BUCKET = 'creatives';
const CREATIVES_CLEAN_BUCKET = 'creatives-clean';
/** GCF must download source_image; clean assets live in a private bucket. */
const EDIT_SOURCE_SIGNED_URL_TTL_SEC = 600;
const DISPATCHER_TIMEOUT_MS = 10_000;

// Wizard ratio id → GCF edit dispatcher's accepted aspect_ratio. Same map
// as the generate dispatcher.
const RATIO_MAP: Record<string, string> = {
  square: '1:1',
  story: '9:16',
  portrait: '1:1',
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
};

// Shape the GCF edit dispatcher accepts per the spec the user gave earlier:
//   { uid, webhook_url, prompt, source_image, aspect_ratio }
interface EditDispatcherPayload {
  uid: string;
  webhook_url: string;
  prompt: string;
  source_image: string;
  aspect_ratio: string;
}

// Orchestrates a single inline edit dispatch:
//   1. Load variant (scoped to caller) + project for aspect_ratio.
//   2. Clean any prior unsaved edit from Storage so we don't leak orphans.
//   3. Reset edit_* columns and mark edit_status='dispatched'.
//   4. POST GCF edit endpoint with source_image = clean_image_url.
//   5. On non-2xx: flip edit_status='failed' with the error.
//
// The variant's MAIN status is untouched throughout — the original image
// stays visible to the FE until the user clicks Save (commit-edit).
@Injectable()
export class DispatchEditService {
  private readonly logger = new Logger(DispatchEditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async dispatch(
    variantId: string,
    userId: string,
    prompt: string,
  ): Promise<{ uid: string; status: string }> {
    const apiSecret = this.config.require('API_SECRET');
    const webhookSecret = this.config.require('WEBHOOK_SECRET');
    const dispatcherUrl = this.config.require('EDIT_DISPATCHER_URL');

    const variant = await this.prisma.creativeGeneration.findFirst({
      where: { id: variantId, userId },
      select: {
        id: true,
        status: true,
        imageUrl: true,
        cleanImageUrl: true,
        editImageUrl: true,
        projectId: true,
      },
    });
    if (!variant) throw new NotFoundException('Variant not found');
    if (variant.status !== GenerationStatus.ready || !variant.imageUrl) {
      throw new BadRequestException('Variant is not ready for editing');
    }

    const project = await this.prisma.project.findFirst({
      where: { id: variant.projectId, userId },
      select: { aspectRatio: true },
    });
    if (!project?.aspectRatio) {
      throw new BadRequestException('Project missing aspect ratio');
    }
    const aspectRatio = RATIO_MAP[project.aspectRatio];
    if (!aspectRatio) {
      throw new BadRequestException(
        `ratio '${project.aspectRatio}' is not supported`,
      );
    }

    // Storage cleanup: drop the previous unsaved edit (if any) so successive
    // Apply clicks don't accumulate orphan PNGs in the bucket.
    if (variant.editImageUrl) {
      const stalePath = this.storage.extractPath(
        variant.editImageUrl,
        CREATIVES_BUCKET,
      );
      if (stalePath) {
        try {
          await this.storage.remove(CREATIVES_BUCKET, [stalePath]);
        } catch (err) {
          this.logger.warn(`Stale edit cleanup failed: ${err}`);
        }
      }
    }

    // Reset edit state on the row before we kick GCF.
    await this.prisma.creativeGeneration.update({
      where: { id: variantId },
      data: {
        editStatus: EditStatus.dispatched,
        editPrompt: prompt,
        editImageUrl: null,
        editErrorMessage: null,
      },
    });

    const sourceImage = await this.resolveEditSourceUrl(variant);
    const webhookUrl = this.buildWebhookUrl(webhookSecret);

    const payload: EditDispatcherPayload = {
      uid: variantId,
      webhook_url: webhookUrl,
      prompt,
      source_image: sourceImage,
      aspect_ratio: aspectRatio,
    };

    const result = await this.postToDispatcher(dispatcherUrl, apiSecret, payload);
    if (!result.ok) {
      await this.prisma.creativeGeneration.update({
        where: { id: variantId },
        data: {
          editStatus: EditStatus.failed,
          editErrorMessage: result.error.slice(0, 1000),
        },
      });
      throw new BadGatewayException('העריכה לא יצאה לדרך — נסו שוב.');
    }

    return { uid: variantId, status: 'dispatched' };
  }

  private async resolveEditSourceUrl(variant: {
    cleanImageUrl: string | null;
    imageUrl: string | null;
  }): Promise<string> {
    const clean = variant.cleanImageUrl;
    if (clean) {
      if (clean.startsWith('http://') || clean.startsWith('https://')) {
        return clean;
      }
      return this.storage.createSignedUrl(
        CREATIVES_CLEAN_BUCKET,
        clean,
        EDIT_SOURCE_SIGNED_URL_TTL_SEC,
      );
    }
    if (!variant.imageUrl) {
      throw new BadRequestException('Variant has no image to edit');
    }
    return variant.imageUrl;
  }

  private buildWebhookUrl(secret: string): string {
    const base = this.config.require('BACKEND_PUBLIC_URL');
    return `${base}/webhooks/creative-edit?token=${encodeURIComponent(secret)}`;
  }

  private async postToDispatcher(
    url: string,
    apiSecret: string,
    payload: EditDispatcherPayload,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISPATCHER_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiSecret}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) return { ok: true };

      let detail = `Edit dispatcher returned ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body?.message === 'string') detail = body.message;
        else if (typeof body?.error === 'string') detail = body.error;
      } catch {
        /* non-JSON */
      }
      this.logger.warn(`edit dispatcher non-ok: ${detail}`);
      return { ok: false, error: detail };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const detail = isAbort
        ? `Edit dispatcher timed out after ${DISPATCHER_TIMEOUT_MS / 1000}s`
        : `Edit dispatcher request failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
      this.logger.error(detail);
      return { ok: false, error: detail };
    } finally {
      clearTimeout(timeout);
    }
  }
}
