import { GenerationStatus, PrismaClient } from '@prisma/client';
import {
  formatGenerationFailureLog,
  mapGenerationErrorForUser,
} from './generation-error.util';

/** Mark a generation row failed after dispatch setup threw (row was left `pending`). */
export async function failGenerationRow(
  prisma: PrismaClient,
  id: string,
  rawMessage: string,
  log?: (line: string) => void,
): Promise<void> {
  const raw =
    rawMessage.trim() ||
    'Dispatch setup failed before the job reached the image worker';
  const errorMessage = mapGenerationErrorForUser(raw).slice(0, 1000);

  log?.(
    formatGenerationFailureLog({
      uid: id,
      kind: 'generate',
      raw,
      userMessage: errorMessage,
    }),
  );

  await prisma.creativeGeneration.updateMany({
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
