import { GenerationStatus, type CreativeGeneration, PrismaClient } from '@prisma/client';
import { mapGenerationErrorForUser } from './generation-error.util';

/** Rows stuck before the GCF worker accepted the job. */
const PENDING_STALE_MS = 2 * 60 * 1000;

/** Rows accepted by GCF but no webhook yet (worker slow / webhook unreachable). */
const DISPATCHED_STALE_MS = 25 * 60 * 1000;

const STALE_PENDING_MSG =
  'הבקשה נתקעה לפני שליחה לשרת היצירה (מצב pending). נסו "יצירה נוספת" או בדקו את הגדרות השרת.';

const STALE_DISPATCHED_MSG =
  'היצירה לקחה יותר מדי זמן ללא תשובה מהשרת. ייתכן ש-webhook לא מגיע ל-backend — בדקו BACKEND_PUBLIC_URL.';

export async function reconcileStaleGenerations(
  prisma: PrismaClient,
  rows: CreativeGeneration[],
): Promise<CreativeGeneration[]> {
  const now = Date.now();
  let changed = false;

  for (const row of rows) {
    const ageMs = now - row.createdAt.getTime();
    const dispatchedAgeMs = now - row.updatedAt.getTime();

    if (row.status === GenerationStatus.pending && ageMs > PENDING_STALE_MS) {
      await prisma.creativeGeneration.update({
        where: { id: row.id },
        data: {
          status: GenerationStatus.failed,
          errorMessage: mapGenerationErrorForUser(STALE_PENDING_MSG).slice(0, 1000),
        },
      });
      changed = true;
      continue;
    }

    if (
      row.status === GenerationStatus.dispatched &&
      dispatchedAgeMs > DISPATCHED_STALE_MS
    ) {
      await prisma.creativeGeneration.update({
        where: { id: row.id },
        data: {
          status: GenerationStatus.failed,
          errorMessage: mapGenerationErrorForUser(STALE_DISPATCHED_MSG).slice(0, 1000),
        },
      });
      changed = true;
    }
  }

  if (!changed) return rows;

  const ids = rows.map((r) => r.id);
  return prisma.creativeGeneration.findMany({
    where: { id: { in: ids } },
    orderBy: { createdAt: 'asc' },
  });
}
