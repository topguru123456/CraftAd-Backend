import { Injectable, Logger } from '@nestjs/common';
import { GenerationStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';
import { VeoApiService } from './veo-api.service';

const VIDEOS_BUCKET = 'creatives';
/* If a row has been in `dispatched` for longer than this, we mark it
 * failed. Veo typically finishes in 1-3min; 15min is a generous
 * upper bound that lets transient queue delays through but catches
 * truly stuck operations. */
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

/* Poll-and-settle service. Owns the "Veo says done → download mp4 →
 * upload to Supabase Storage → flip the DB row to ready" transition.
 *
 * Why this lives in its own service:
 *   VideoDispatchService submits and returns. VideoGenerationsService
 *   reads. Settling an in-flight row when it polls done is a third
 *   responsibility — the work IS conceptually a settle, and putting
 *   it on either of the other two services would tangle their scope.
 *
 * Concurrency: in-process Map of in-flight poll promises keyed by
 * row id. If a second caller asks to poll the same row while a poll
 * is in flight, both await the same promise — single Veo round-trip,
 * single Storage upload, single DB write. Safe under the FE's 10s
 * client poll across multiple tabs (within one process) and against
 * concurrent list/get calls.
 *
 * No cross-process locking: we run a single Cloud Run instance for
 * the backend today. If we ever scale to N instances and two instances
 * happen to poll the same row simultaneously, the WORST case is two
 * downloads + two Storage uploads (Storage upsert is idempotent on
 * the path we use) + two no-op DB updates. Acceptable, and we can
 * add a distributed lock later if it ever bites.
 */
@Injectable()
export class VeoPollService {
  private readonly logger = new Logger(VeoPollService.name);
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly veo: VeoApiService,
  ) {}

  /* Poll every dispatched/pending row for a project (user-scoped).
   * Used by VideoGenerationsService.listByProject so the FE's 10s
   * poll on useVideoVariants drives the backend to refresh
   * in-flight rows transparently — caller sees fresh data without
   * thinking about polling. */
  async pollProject(projectId: string, userId: string): Promise<void> {
    const inflightRows = await this.prisma.videoGeneration.findMany({
      where: {
        projectId,
        userId,
        status: {
          in: [GenerationStatus.pending, GenerationStatus.dispatched],
        },
      },
      select: { id: true, operationName: true, createdAt: true },
    });
    if (inflightRows.length === 0) return;

    await Promise.allSettled(
      inflightRows.map((r) => this.pollOne(r.id)),
    );
  }

  /* Poll a single row by id. Dedupes via the inflight Map — if a poll
   * for this row is already running, the second caller awaits the
   * same promise rather than launching a parallel Veo round-trip. */
  async pollOne(rowId: string): Promise<void> {
    const existing = this.inflight.get(rowId);
    if (existing) return existing;
    const work = this.pollOneInner(rowId).finally(() => {
      this.inflight.delete(rowId);
    });
    this.inflight.set(rowId, work);
    return work;
  }

  private async pollOneInner(rowId: string): Promise<void> {
    const row = await this.prisma.videoGeneration.findUnique({
      where: { id: rowId },
      select: {
        id: true,
        userId: true,
        status: true,
        operationName: true,
        createdAt: true,
      },
    });
    if (!row) return;
    if (row.status !== GenerationStatus.pending && row.status !== GenerationStatus.dispatched) {
      return; // already terminal
    }
    if (!row.operationName) {
      /* Edge case: row is in `pending` but has no operation name
       * yet — means dispatch is still mid-submit. Skip; the
       * dispatcher will populate it shortly. */
      return;
    }

    /* Stuck-row safeguard. If Veo's been chewing on this for >15min
     * something's wrong (silent failure, dropped operation, etc).
     * Mark failed so the FE stops spinning forever and the user can
     * delete + re-dispatch. */
    const ageMs = Date.now() - row.createdAt.getTime();
    if (ageMs > POLL_TIMEOUT_MS) {
      await this.markFailed(rowId, 'Veo did not complete within 15 minutes');
      return;
    }

    const poll = await this.veo.poll(row.operationName);
    if (!poll.done) return; // still cooking

    if (poll.status === 'fetch_error') {
      this.logger.warn(`Veo poll fetch error for ${rowId}: ${poll.reason}`);
      /* Transient network/API errors should NOT fail the row — the
       * next FE poll tick (10s later) gets another chance. Just log
       * and return. */
      return;
    }

    if (poll.status === 'error') {
      await this.markFailed(rowId, poll.message);
      return;
    }

    /* Success path: download from Veo's signed URL → upload to our
     * bucket → atomic flip. If any of these fail, the row stays
     * dispatched and the next poll tick retries — until the 15min
     * cap kicks in. */
    const dl = await this.veo.download(poll.videoUri);
    if (!dl.ok) {
      this.logger.warn(`Veo download failed for ${rowId}: ${dl.reason}`);
      return; // retry on next poll
    }

    const videoPath = `${row.userId}/${rowId}.mp4`;
    let videoPublicUrl: string;
    try {
      const uploaded = await this.storage.upload(
        VIDEOS_BUCKET,
        videoPath,
        dl.bytes,
        dl.contentType,
      );
      videoPublicUrl = uploaded.publicUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Storage upload failed for ${rowId}: ${message}`);
      return; // retry on next poll
    }

    /* Poster is best-effort. If Veo gave us one, fetch + upload it.
     * If download fails, leave posterUrl null — the row still flips
     * to ready and the HTML5 player just shows its default empty
     * frame until play. We don't want a poster failure to block the
     * actual mp4 from going live. */
    let posterPublicUrl: string | null = null;
    if (poll.posterUri) {
      const posterDl = await this.veo.download(poll.posterUri);
      if (posterDl.ok) {
        try {
          const posterPath = `${row.userId}/${rowId}.poster.jpg`;
          const uploaded = await this.storage.upload(
            VIDEOS_BUCKET,
            posterPath,
            posterDl.bytes,
            posterDl.contentType || 'image/jpeg',
          );
          posterPublicUrl = uploaded.publicUrl;
        } catch (err) {
          this.logger.warn(
            `Poster upload failed for ${rowId} (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    /* Atomic flip: only flip if the row is STILL in pending/
     * dispatched. Guards against a concurrent poll on another
     * instance (or a row that was deleted mid-poll) downgrading a
     * terminal row. */
    const updated = await this.prisma.videoGeneration.updateMany({
      where: {
        id: rowId,
        status: {
          in: [GenerationStatus.pending, GenerationStatus.dispatched],
        },
      },
      data: {
        status: GenerationStatus.ready,
        videoUrl: videoPublicUrl,
        posterUrl: posterPublicUrl,
        errorMessage: null,
      },
    });

    if (updated.count === 0) {
      /* Race lost — another poll already flipped this row. Storage
       * has an orphan copy at the same path (upsert overwrites) so
       * no GC needed. */
      this.logger.warn(`Row ${rowId} was already terminal during ready flip`);
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
