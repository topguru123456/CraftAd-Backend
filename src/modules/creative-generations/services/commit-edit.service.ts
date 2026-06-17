import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EditStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';
import { ScoringService } from '../../scoring/services/scoring.service';

const CREATIVES_BUCKET = 'creatives';
const CREATIVES_CLEAN_BUCKET = 'creatives-clean';

// Save (commit) — promotes the edit candidate to the main image:
//   1. Validate that an edit is ready.
//   2. Atomic UPDATE: image_url + clean_image_url = edit_image_url,
//      clear edit_*, reset scores (new image needs new scores).
//   3. Best-effort: delete the OLD main file from Storage.
//   4. Fire scoring async — same fire-and-forget pattern as the webhook.
//
// Best-effort Storage delete because losing one orphan PNG is acceptable;
// rolling back the commit because Storage hiccuped is not.
@Injectable()
export class CommitEditService {
  private readonly logger = new Logger(CommitEditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly scoring: ScoringService,
  ) {}

  async commit(
    variantId: string,
    userId: string,
  ): Promise<{ imageUrl: string }> {
    const row = await this.prisma.creativeGeneration.findFirst({
      where: { id: variantId, userId },
      select: {
        id: true,
        imageUrl: true,
        cleanImageUrl: true,
        thumbnailUrl: true,
        editStatus: true,
        editImageUrl: true,
        editCleanImageUrl: true,
      },
    });
    if (!row) throw new NotFoundException('Variant not found');
    if (row.editStatus !== EditStatus.ready || !row.editImageUrl) {
      throw new BadRequestException('No edit ready to save');
    }

    // Old paths to clean up after the promotion. imageUrl lives in the
    // PUBLIC creatives bucket (URL form); cleanImageUrl is a PATH in the
    // PRIVATE creatives-clean bucket. We track them separately because
    // they're in different buckets and need separate remove() calls.
    const oldPublicPath = row.imageUrl
      ? this.storage.extractPath(row.imageUrl, CREATIVES_BUCKET)
      : null;
    const oldCleanPath = row.cleanImageUrl ?? null; // already a path, not a URL
    /* Thumbnail of the OLD main image — now stale. Tracked so we can
     * delete the orphan after the commit lands. The new image's
     * thumbnail isn't regenerated here (would add ~2-5s to the commit
     * RTT for a fetch + sharp + upload); the row's thumbnailUrl is
     * nulled and the FE falls back to imageUrl for that one variant
     * until the next webhook-driven thumbnail lands. */
    const oldThumbnailPath = row.thumbnailUrl
      ? this.storage.extractPath(row.thumbnailUrl, CREATIVES_BUCKET)
      : null;

    const newImageUrl = row.editImageUrl;
    // Legacy fallback: rows that pre-date the editCleanImageUrl column
    // (or edits dispatched before the column was added) have no clean
    // edit path. Fall back to the watermarked URL so the row stays
    // queryable — downloads of those legacy rows will get the watermarked
    // version. Acceptable degradation; no backfill needed.
    const newCleanImageUrl = row.editCleanImageUrl ?? newImageUrl;

    // Single UPDATE so the row is never in a torn state. Scoring fields
    // are reset to null — the new image needs fresh scoring.
    await this.prisma.creativeGeneration.update({
      where: { id: variantId },
      data: {
        imageUrl: newImageUrl,
        cleanImageUrl: newCleanImageUrl,
        /* Null the stale thumbnail — its bytes correspond to the
         * pre-edit image. FE falls back to imageUrl for this variant
         * until/unless a future change regenerates the thumbnail on
         * commit. */
        thumbnailUrl: null,
        editStatus: null,
        editImageUrl: null,
        editCleanImageUrl: null,
        editPrompt: null,
        editErrorMessage: null,
        scoredAt: null,
        creativeScore: null,
        performanceScore: null,
        recommendations: [],
      },
    });

    // Storage cleanup — best-effort, per-bucket. We don't want a storage
    // hiccup to roll back the user-visible commit; orphan PNGs are
    // acceptable. Skip self-deletion when the old path equals the new
    // (happens on legacy rows where edit reused the same filename).
    if (oldPublicPath && oldPublicPath !== this.storage.extractPath(newImageUrl, CREATIVES_BUCKET)) {
      try {
        await this.storage.remove(CREATIVES_BUCKET, [oldPublicPath]);
      } catch (err) {
        this.logger.warn(`Old public file cleanup failed: ${err}`);
      }
    }
    if (oldCleanPath && oldCleanPath !== newCleanImageUrl) {
      try {
        await this.storage.remove(CREATIVES_CLEAN_BUCKET, [oldCleanPath]);
      } catch (err) {
        this.logger.warn(`Old clean file cleanup failed: ${err}`);
      }
    }
    if (oldThumbnailPath) {
      try {
        await this.storage.remove(CREATIVES_BUCKET, [oldThumbnailPath]);
      } catch (err) {
        this.logger.warn(`Old thumbnail file cleanup failed: ${err}`);
      }
    }

    // Re-score on the new image. Fire-and-forget, same pattern as the
    // generation webhook — scores arrive a few seconds later via Realtime.
    this.scoring.score(variantId).catch((err) => {
      this.logger.error(`Post-commit scoring failed for ${variantId}:`, err);
    });

    return { imageUrl: newImageUrl };
  }
}
