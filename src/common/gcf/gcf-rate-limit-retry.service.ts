import { Injectable, Logger } from '@nestjs/common';
import { EditStatus, GenerationStatus } from '@prisma/client';
import {
  formatGenerationFailureLog,
  GCF_RATE_LIMIT_MAX_RETRIES,
  isRetryableRateLimitError,
  mapGenerationErrorForUser,
  rateLimitRetryDelayMs,
} from '../generation-errors/generation-error.util';
import { PrismaService } from '../prisma/prisma.service';
import { GcfRedispatchService } from './gcf-redispatch.service';

@Injectable()
export class GcfRateLimitRetryService {
  private readonly logger = new Logger(GcfRateLimitRetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redispatch: GcfRedispatchService,
  ) {}

  /**
   * On Gemini 429: keep row in-flight and redispatch after backoff.
   * Returns true if a retry was scheduled (caller should not mark failed).
   */
  async tryScheduleGenerationRetry(
    generationId: string,
    rawMessage: string,
  ): Promise<boolean> {
    if (!isRetryableRateLimitError(rawMessage)) return false;

    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: generationId },
      select: { gcfRetryCount: true, status: true },
    });
    if (!row) return false;
    if (
      row.status !== GenerationStatus.pending &&
      row.status !== GenerationStatus.dispatched
    ) {
      return false;
    }
    if (row.gcfRetryCount >= GCF_RATE_LIMIT_MAX_RETRIES) return false;

    void this.runGenerationRetry(generationId, rawMessage).catch((err) => {
      this.logger.error(
        `Generation retry loop crashed for ${generationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return true;
  }

  async tryScheduleEditRetry(
    generationId: string,
    rawMessage: string,
  ): Promise<boolean> {
    if (!isRetryableRateLimitError(rawMessage)) return false;

    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: generationId },
      select: { editGcfRetryCount: true, editStatus: true },
    });
    if (!row?.editStatus) return false;
    if (
      row.editStatus !== EditStatus.pending &&
      row.editStatus !== EditStatus.dispatched
    ) {
      return false;
    }
    if (row.editGcfRetryCount >= GCF_RATE_LIMIT_MAX_RETRIES) return false;

    void this.runEditRetry(generationId, rawMessage).catch((err) => {
      this.logger.error(
        `Edit retry loop crashed for ${generationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return true;
  }

  private async runGenerationRetry(generationId: string, rawMessage: string): Promise<void> {
    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: generationId },
      select: { gcfRetryCount: true, status: true },
    });
    if (!row) return;
    if (row.status !== GenerationStatus.pending && row.status !== GenerationStatus.dispatched) {
      return;
    }
    if (row.gcfRetryCount >= GCF_RATE_LIMIT_MAX_RETRIES) {
      await this.finalizeGenerationFailure(generationId, rawMessage, row.gcfRetryCount);
      return;
    }

    const attempt = row.gcfRetryCount + 1;
    const delayMs = rateLimitRetryDelayMs(attempt);
    const userMessage = mapGenerationErrorForUser(rawMessage);

    this.logger.warn(
      formatGenerationFailureLog({
        uid: generationId,
        kind: 'generate',
        raw: rawMessage,
        userMessage,
        retrying: true,
        attempt,
        maxAttempts: GCF_RATE_LIMIT_MAX_RETRIES,
      }) + ` delayMs=${delayMs}`,
    );

    await this.prisma.creativeGeneration.update({
      where: { id: generationId },
      data: {
        gcfRetryCount: attempt,
        status: GenerationStatus.dispatched,
        errorMessage: null,
      },
    });

    await sleep(delayMs);

    const result = await this.redispatch.redispatchGeneration(generationId);
    if (!result.ok) {
      this.logger.warn(
        `Generation redispatch failed uid=${generationId} attempt=${attempt} error=${result.error ?? 'unknown'}`,
      );
      if (result.error && isRetryableRateLimitError(result.error)) {
        await this.runGenerationRetry(generationId, result.error);
      } else {
        await this.finalizeGenerationFailure(
          generationId,
          result.error ?? rawMessage,
          attempt,
        );
      }
    }
  }

  private async runEditRetry(generationId: string, rawMessage: string): Promise<void> {
    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: generationId },
      select: { editGcfRetryCount: true, editStatus: true },
    });
    if (!row?.editStatus) return;
    if (
      row.editStatus !== EditStatus.pending &&
      row.editStatus !== EditStatus.dispatched
    ) {
      return;
    }
    if (row.editGcfRetryCount >= GCF_RATE_LIMIT_MAX_RETRIES) {
      await this.finalizeEditFailure(generationId, rawMessage, row.editGcfRetryCount);
      return;
    }

    const attempt = row.editGcfRetryCount + 1;
    const delayMs = rateLimitRetryDelayMs(attempt);
    const userMessage = mapGenerationErrorForUser(rawMessage);

    this.logger.warn(
      formatGenerationFailureLog({
        uid: generationId,
        kind: 'edit',
        raw: rawMessage,
        userMessage,
        retrying: true,
        attempt,
        maxAttempts: GCF_RATE_LIMIT_MAX_RETRIES,
      }) + ` delayMs=${delayMs}`,
    );

    await this.prisma.creativeGeneration.update({
      where: { id: generationId },
      data: {
        editGcfRetryCount: attempt,
        editStatus: EditStatus.dispatched,
        editErrorMessage: null,
      },
    });

    await sleep(delayMs);

    const result = await this.redispatch.redispatchEdit(generationId);
    if (!result.ok) {
      this.logger.warn(
        `Edit redispatch failed uid=${generationId} attempt=${attempt} error=${result.error ?? 'unknown'}`,
      );
      if (result.error && isRetryableRateLimitError(result.error)) {
        await this.runEditRetry(generationId, result.error);
      } else {
        await this.finalizeEditFailure(generationId, result.error ?? rawMessage, attempt);
      }
    }
  }

  private async finalizeGenerationFailure(
    id: string,
    raw: string,
    attempts: number,
  ): Promise<void> {
    const exhausted =
      attempts >= GCF_RATE_LIMIT_MAX_RETRIES && isRetryableRateLimitError(raw);
    const userMessage = exhausted
      ? 'עומס זמני בשרת Gemini — ניסינו שוב אוטומטית מספר פעמים ללא הצלחה. המתינו דקה ולחצו "יצירה נוספת".'
      : mapGenerationErrorForUser(raw);

    this.logger.error(
      formatGenerationFailureLog({
        uid: id,
        kind: 'generate',
        raw,
        userMessage,
        attempt: attempts,
        maxAttempts: GCF_RATE_LIMIT_MAX_RETRIES,
      }),
    );

    await this.prisma.creativeGeneration.updateMany({
      where: {
        id,
        status: { in: [GenerationStatus.pending, GenerationStatus.dispatched] },
      },
      data: {
        status: GenerationStatus.failed,
        errorMessage: userMessage.slice(0, 1000),
      },
    });
  }

  private async finalizeEditFailure(
    id: string,
    raw: string,
    attempts: number,
  ): Promise<void> {
    const exhausted =
      attempts >= GCF_RATE_LIMIT_MAX_RETRIES && isRetryableRateLimitError(raw);
    const userMessage = exhausted
      ? 'עומס זמני בשרת Gemini — ניסינו שוב אוטומטית מספר פעמים ללא הצלחה. המתינו ונסו להחיל את העריכה שוב.'
      : mapGenerationErrorForUser(raw);

    this.logger.error(
      formatGenerationFailureLog({
        uid: id,
        kind: 'edit',
        raw,
        userMessage,
        attempt: attempts,
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
        editErrorMessage: userMessage.slice(0, 1000),
      },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
