import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EditStatus, GenerationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/* Ages out stuck generation rows.
 *
 * The image-dispatch path now leaves rows in `dispatched` even when
 * the initial dispatcher call returns non-OK, on the assumption that
 * the GCF dispatcher will retry internally and webhook the final
 * outcome. If that webhook never arrives — worker crash, queue lost,
 * dispatcher gave up silently — the row would otherwise stay
 * "loading" forever on the FE. This reaper is the safety net.
 *
 * Threshold and cadence:
 *   - 1 hour past the row's last write is the product-side cutoff:
 *     long enough that no realistic dispatcher retry budget is still
 *     alive, short enough that the user gets a definitive "failed"
 *     and a retry CTA before they give up entirely.
 *   - Cron every 5 minutes balances responsiveness (no row waits
 *     much past 1h05m) against DB churn (a no-op updateMany on an
 *     indexed field is negligible).
 *
 * Edit-side caveat:
 *   editStatus is paired with the same row's `updatedAt`, which gets
 *   bumped by ANY field write (e.g., a user toggling the bookmark
 *   during an in-flight edit). Such writes will mask a stuck edit
 *   from the reaper until the next idle hour. Acceptable for now;
 *   a dedicated `editDispatchedAt` column is the proper fix if this
 *   edge case ever bites in practice.
 */

const STUCK_AGE_MS = 60 * 60 * 1000; // 1 hour
const STUCK_GENERATION_MESSAGE =
  'התהליך נמשך זמן רב מהצפוי. נסו לייצר שוב.';
const STUCK_EDIT_MESSAGE =
  'העריכה נמשכה זמן רב מהצפוי. נסו שוב.';

@Injectable()
export class GenerationReaperService {
  private readonly logger = new Logger(GenerationReaperService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'generation-reaper' })
  async reap(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_AGE_MS);

    const stuckGenerations = await this.prisma.creativeGeneration.updateMany({
      where: {
        status: { in: [GenerationStatus.pending, GenerationStatus.dispatched] },
        createdAt: { lt: cutoff },
      },
      data: {
        status: GenerationStatus.failed,
        errorMessage: STUCK_GENERATION_MESSAGE,
      },
    });

    const stuckEdits = await this.prisma.creativeGeneration.updateMany({
      where: {
        editStatus: { in: [EditStatus.pending, EditStatus.dispatched] },
        updatedAt: { lt: cutoff },
      },
      data: {
        editStatus: EditStatus.failed,
        editErrorMessage: STUCK_EDIT_MESSAGE,
      },
    });

    if (stuckGenerations.count > 0 || stuckEdits.count > 0) {
      this.logger.warn(
        `reaper aged out ${stuckGenerations.count} generation row(s) + ${stuckEdits.count} edit row(s)`,
      );
    }
  }
}
