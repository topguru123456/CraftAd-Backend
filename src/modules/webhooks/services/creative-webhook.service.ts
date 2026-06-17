import { Injectable, Logger } from '@nestjs/common';
import { GenerationStatus } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';
import { ScoringService } from '../../scoring/services/scoring.service';
import { WatermarkService } from '../../watermark/services/watermark.service';
import {
  formatGenerationFailureLog,
  isRetryableRateLimitError,
  mapGenerationErrorForUser,
} from '../../../common/generation-errors/generation-error.util';
import { validateImageRatio } from '../../../common/aspect-ratio/aspect-ratio.util';
import { CreativeWebhookDto } from '../dto/creative-webhook.dto';

const CREATIVES_BUCKET = 'creatives';
const CREATIVES_CLEAN_BUCKET = 'creatives-clean';

/* Thumbnail spec for the project-detail grid.
 *
 *   width 800   covers 2x DPI for the typical 400-500px-wide card
 *   quality 80  sweet-spot for JPEG marketing imagery
 *   mozjpeg     ~10-15% smaller files at the same quality
 *
 * A typical Imagen output (~500KB-2MB PNG) shrinks to ~40-80KB JPEG,
 * which is the whole point of the column. The watermark is baked
 * into the source bytes before this runs, so the thumbnail carries
 * the watermark too — no leak path through the thumbnail URL. */
const THUMBNAIL_WIDTH = 800;
const THUMBNAIL_QUALITY = 80;

// Outcome envelope returned to GCF. Always 200 OK with a `reason` so
// Cloud Tasks doesn't retry idempotent / unrecoverable cases.
export interface WebhookOutcome {
  ok: true;
  reason?: string;
}

// Orchestrates the webhook flow:
//   1. Load row by uid (service-role read — bypasses RLS).
//   2. Idempotency short-circuit for terminal rows.
//   3. Error branch: mark failed with the worker's message.
//   4. Success branch: decode → upload → atomic flip to ready.
//
// Every recoverable / expected failure surfaces as a row-level `failed`
// status (so the user sees it in the UI) rather than a 5xx response (so
// Cloud Tasks stops retrying).

@Injectable()
export class CreativeWebhookService {
  private readonly logger = new Logger(CreativeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly scoring: ScoringService,
    private readonly watermark: WatermarkService,
  ) {}

  async handle(body: CreativeWebhookDto): Promise<WebhookOutcome> {
    /* Project's serviceType is fetched alongside the row so we can
     * gate downstream side-effects (scoring) per flow without a second
     * round-trip. Product-images projects produce photographs, not
     * ads — running the GPT-4o "creative + performance" scoring on
     * them would write numerically-tuned-for-ad-effectiveness scores
     * onto a product photo, which is semantically misleading. We skip
     * the scoring fire-and-forget below for that service type. */
    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: body.uid },
      select: {
        id: true,
        userId: true,
        status: true,
        /* `aspectRatio` is the wizard-stored id (story / square /
         * portrait / landscape). validateImageRatio maps it to the
         * Imagen-API value internally and compares against the
         * returned PNG's header dimensions. */
        project: { select: { serviceType: true, aspectRatio: true } },
      },
    });

    // Worker references a uid we don't know — stale retry after delete,
    // or forged callback. 200 OK so Cloud Tasks stops.
    if (!row) return { ok: true, reason: 'unknown_uid' };

    if (row.status === 'ready' || row.status === 'failed') {
      return { ok: true, reason: 'already_terminal' };
    }

    if (body.status === 'error') {
      const raw = body.message ?? 'Generation failed';
      /* Rate-limit / 429 / RESOURCE_EXHAUSTED errors are treated as
       * transient and never surface a toast — per product decision,
       * the user shouldn't see "AI is overloaded" pop-ups every time
       * Gemini back-pressures. The row stays in `dispatched` and the
       * GenerationReaperService marks it failed after 1h with a
       * generic timeout message if no success webhook ever lands.
       * All other error shapes (safety blocks, invalid arguments,
       * "no image" refusals) still mark failed immediately so the
       * user sees the actionable Hebrew message and can adjust. */
      if (isRetryableRateLimitError(raw)) {
        this.logger.warn(
          `rate-limit webhook for ${row.id} (keeping in dispatched, reaper will age out): ${raw}`,
        );
        return { ok: true, reason: 'rate_limit_transient' };
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

    /* Aspect-ratio sanity check.
     *
     * Imagen's `parameters.aspectRatio` is documented as guidance, not
     * strict — when the reference inputs are square the model
     * sometimes letterboxes a square composition into a 9:16 canvas.
     * The dispatcher payload + prompt block already minimize this;
     * this check is the last line of defense, rejecting before we
     * spend storage bandwidth uploading a misshapen result.
     *
     * `validateImageRatio` returns null when it can't judge (unknown
     * stored ratio, non-PNG bytes, etc.), in which case we proceed as
     * before — the validator NEVER rejects on its own uncertainty. */
    const ratioCheck = validateImageRatio(bytes, row.project?.aspectRatio);
    if (ratioCheck && !ratioCheck.ok) {
      this.logger.warn(`Ratio check failed for ${row.id}: ${ratioCheck.reason}`);
      await this.markFailed(row.id, ratioCheck.reason);
      return { ok: true, reason: 'ratio_mismatch' };
    }

    // Two uploads, two buckets. Order matters: clean goes to the PRIVATE
    // bucket first so even a failed watermark step doesn't leak the
    // original to the public bucket. Watermark is a transform on the same
    // bytes — if the asset isn't loaded the service passes through and
    // we end up with identical public + private files (display still
    // works, no security drop, just no visual watermark until the asset
    // appears at backend/assets/watermark.png).
    const filename = `${row.userId}/${row.id}.png`;
    const thumbnailFilename = `${row.userId}/${row.id}-thumb.jpg`;
    let publicUrl: string;
    let cleanPath: string;
    let watermarkedBytes: Uint8Array;
    try {
      const cleanUpload = await this.storage.uploadPrivate(
        CREATIVES_CLEAN_BUCKET,
        filename,
        bytes,
        'image/png',
      );
      cleanPath = cleanUpload.path;

      watermarkedBytes = await this.watermark.apply(bytes);
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

    /* Thumbnail upload. Isolated in its own try so a sharp/upload
     * hiccup doesn't fail an otherwise-successful row — the row just
     * lands with thumbnailUrl=null and the FE falls back to imageUrl
     * (degrades to today's behaviour, no user-visible failure). */
    const thumbnailUrl = await this.buildAndUploadThumbnail(
      watermarkedBytes,
      thumbnailFilename,
      row.id,
    );

    // Atomic flip — guards against concurrent retries downgrading a
    // row that's already terminal. imageUrl is the public watermarked
    // URL the FE renders; cleanImageUrl is the PATH (not a URL) in the
    // private bucket — the downloads endpoint mints a signed URL from
    // it after a quota check. Storing a path here (not a public URL)
    // is the security boundary: a leaked DB row can't be turned into a
    // direct file fetch.
    const updated = await this.prisma.creativeGeneration.updateMany({
      where: {
        id: row.id,
        status: { in: [GenerationStatus.pending, GenerationStatus.dispatched] },
      },
      data: {
        status: GenerationStatus.ready,
        imageUrl: publicUrl,
        cleanImageUrl: cleanPath,
        thumbnailUrl,
        errorMessage: null,
      },
    });

    if (updated.count === 0) {
      // Lost the race — another concurrent webhook already flipped the
      // row. Not an error; just stop here (scoring already fired or will).
      this.logger.warn(`Row ${row.id} was already terminal during ready flip`);
      return { ok: true };
    }

    // Fire-and-forget scoring. The webhook returns 200 to GCF immediately;
    // OpenAI call + DB write happen in the background. Failures inside
    // ScoringService log and resolve to { ok: true, reason } — the catch
    // here only triggers on actual thrown exceptions (e.g. missing API key).
    //
    // Scoring runs for every image-output service type (campaign-creative,
    // product-images, advertising-package's image side). An earlier
    // version skipped product-images on the rationale that ad-scoring
    // would write meaningless numbers on product photos — that product
    // decision has been reversed: the score sort UI on the project
    // detail page now expects every image row to carry a score, and the
    // user's review treats the same rubric as useful enough across both
    // flows. The score will still be lower-signal on a bare product
    // photo vs a real ad, but that's a UX tradeoff (the user reading the
    // number) rather than a correctness problem.
    this.scoring.score(row.id).catch((err) => {
      this.logger.error(`Scoring fire-and-forget failed for ${row.id}:`, err);
    });

    return { ok: true };
  }

  /* Builds + uploads the project-detail-grid thumbnail. Returns the
   * public URL on success or null on any failure — the caller writes
   * null into thumbnailUrl in the null case, and the FE falls back to
   * the full imageUrl. */
  private async buildAndUploadThumbnail(
    watermarkedBytes: Uint8Array,
    path: string,
    uid: string,
  ): Promise<string | null> {
    try {
      const thumbBuffer = await sharp(watermarkedBytes)
        .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: THUMBNAIL_QUALITY, mozjpeg: true })
        .toBuffer();
      const uploaded = await this.storage.upload(
        CREATIVES_BUCKET,
        path,
        new Uint8Array(thumbBuffer),
        'image/jpeg',
      );
      return uploaded.publicUrl;
    } catch (err) {
      this.logger.warn(
        `Thumbnail build/upload failed for ${uid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // Accepts both bare base64 and the `data:image/...;base64,` prefixed form.
  private decodeBase64(b64: string): Uint8Array {
    const stripped = b64.startsWith('data:')
      ? b64.slice(b64.indexOf(',') + 1)
      : b64;
    // Buffer.from validates length-mod-4 etc. internally; invalid input
    // produces empty or short output rather than throwing in older Nodes,
    // so we also sanity-check the byte length downstream.
    const buf = Buffer.from(stripped, 'base64');
    if (buf.length === 0) {
      throw new Error('decoded payload is empty');
    }
    return new Uint8Array(buf);
  }

  private async markFailed(id: string, rawMessage: string): Promise<void> {
    const errorMessage = mapGenerationErrorForUser(rawMessage).slice(0, 1000);

    this.logger.error(
      formatGenerationFailureLog({
        uid: id,
        kind: 'generate',
        raw: rawMessage,
        userMessage: errorMessage,
      }),
    );

    await this.prisma.creativeGeneration.updateMany({
      where: {
        id,
        status: { in: [GenerationStatus.pending, GenerationStatus.dispatched] },
      },
      data: {
        status: GenerationStatus.failed,
        errorMessage,
      },
    });
  }
}
