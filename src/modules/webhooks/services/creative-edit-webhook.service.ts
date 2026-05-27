import { Injectable, Logger } from '@nestjs/common';
import { EditStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';
import { WatermarkService } from '../../watermark/services/watermark.service';
import { GcfRateLimitRetryService } from '../../../common/gcf/gcf-rate-limit-retry.service';
import {
  formatGenerationFailureLog,
  GCF_RATE_LIMIT_MAX_RETRIES,
  isRetryableRateLimitError,
  mapGenerationErrorForUser,
} from '../../../common/generation-errors/generation-error.util';
import { CreativeEditWebhookDto } from '../dto/creative-edit-webhook.dto';

const CREATIVES_BUCKET = 'creatives';
const CREATIVES_CLEAN_BUCKET = 'creatives-clean';

export interface WebhookOutcome {
  ok: true;
  reason?: string;
}

// Same shape as CreativeWebhookService but writes to the edit_* columns
// instead of the main image columns. Main image stays untouched until
// the user clicks Save (commit-edit). No scoring fires here — scoring
// only runs on committed images.
//
// Storage path includes a timestamp so successive Apply clicks don't
// clobber each other in the rare case where two webhooks for the same
// variant race (Cloud Tasks retry + a slow original both landing).
@Injectable()
export class CreativeEditWebhookService {
  private readonly logger = new Logger(CreativeEditWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly watermark: WatermarkService,
    private readonly rateLimitRetry: GcfRateLimitRetryService,
  ) {}

  async handle(body: CreativeEditWebhookDto): Promise<WebhookOutcome> {
    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: body.uid },
      select: { id: true, userId: true, editStatus: true },
    });
    if (!row) return { ok: true, reason: 'unknown_uid' };

    if (
      row.editStatus === EditStatus.ready ||
      row.editStatus === EditStatus.failed
    ) {
      return { ok: true, reason: 'already_terminal' };
    }

    if (body.status === 'error') {
      const raw =
        typeof body.message === 'string' && body.message.trim()
          ? body.message.trim()
          : 'Edit failed';
      if (await this.rateLimitRetry.tryScheduleEditRetry(row.id, raw)) {
        return { ok: true, reason: 'rate_limit_retry' };
      }
      await this.markFailed(row.id, raw);
      return { ok: true, reason: 'worker_error' };
    }

    if (!body.image_base64?.trim()) {
      await this.markFailed(row.id, 'Missing image_base64 in success payload');
      return { ok: true, reason: 'missing_image' };
    }

    let bytes: Uint8Array;
    try {
      bytes = this.decodeBase64(body.image_base64);
    } catch (err) {
      this.logger.warn(`Base64 decode failed for ${row.id}: ${err}`);
      await this.markFailed(row.id, 'Invalid base64 in payload');
      return { ok: true, reason: 'bad_base64' };
    }

    // Mirror of CreativeWebhookService's two-bucket split. The timestamp
    // suffix is shared between clean + watermarked uploads so the pair
    // is unambiguously co-versioned; subsequent Apply clicks produce new
    // timestamped pairs without clobbering the previous round.
    const filename = `${row.userId}/${row.id}-edit-${Date.now()}.png`;
    let publicUrl: string;
    let cleanPath: string;
    try {
      const cleanUpload = await this.storage.uploadPrivate(
        CREATIVES_CLEAN_BUCKET,
        filename,
        bytes,
        'image/png',
      );
      cleanPath = cleanUpload.path;

      const watermarkedBytes = await this.watermark.apply(bytes);
      const publicUpload = await this.storage.upload(
        CREATIVES_BUCKET,
        filename,
        watermarkedBytes,
        'image/png',
      );
      publicUrl = publicUpload.publicUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(row.id, `Storage upload failed: ${message}`);
      return { ok: true, reason: 'upload_failed' };
    }

    // Atomic flip — same guard pattern as CreativeWebhookService. Lost
    // race is harmless (means another concurrent retry already wrote).
    const updated = await this.prisma.creativeGeneration.updateMany({
      where: {
        id: row.id,
        editStatus: { in: [EditStatus.pending, EditStatus.dispatched] },
      },
      data: {
        editStatus: EditStatus.ready,
        editImageUrl: publicUrl,
        editCleanImageUrl: cleanPath,
        editErrorMessage: null,
      },
    });

    if (updated.count === 0) {
      this.logger.warn(`Row ${row.id} edit already terminal during ready flip`);
    }

    return { ok: true };
  }

  private decodeBase64(b64: string): Uint8Array {
    const stripped = b64.startsWith('data:')
      ? b64.slice(b64.indexOf(',') + 1)
      : b64;
    const buf = Buffer.from(stripped, 'base64');
    if (buf.length === 0) throw new Error('decoded payload is empty');
    return new Uint8Array(buf);
  }

  private async markFailed(id: string, rawMessage: string): Promise<void> {
    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id },
      select: { editGcfRetryCount: true },
    });
    const userMessage = this.resolveUserErrorMessage(
      rawMessage,
      row?.editGcfRetryCount ?? 0,
    ).slice(0, 1000);

    this.logger.error(
      formatGenerationFailureLog({
        uid: id,
        kind: 'edit',
        raw: rawMessage,
        userMessage,
        attempt: row?.editGcfRetryCount,
        maxAttempts: GCF_RATE_LIMIT_MAX_RETRIES,
      }),
    );

    await this.prisma.creativeGeneration.updateMany({
      where: {
        id,
        editStatus: { in: [EditStatus.pending, EditStatus.dispatched] },
      },
      data: {
        editStatus: EditStatus.failed,
        editErrorMessage: userMessage,
      },
    });
  }

  private resolveUserErrorMessage(raw: string, retryCount: number): string {
    if (
      isRetryableRateLimitError(raw) &&
      retryCount >= GCF_RATE_LIMIT_MAX_RETRIES
    ) {
      return (
        'עומס זמני בשרת Gemini — ניסינו שוב אוטומטית מספר פעמים ללא הצלחה. ' +
        'המתינו ונסו להחיל את העריכה שוב.'
      );
    }
    return mapGenerationErrorForUser(raw);
  }
}
