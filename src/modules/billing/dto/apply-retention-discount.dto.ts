import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  CANCELLATION_REASONS,
  CancellationReason,
} from './cancel-subscription.dto';

/* Body for POST /billing/tranzila/apply-retention-discount.
 *
 * Called from step 2 ("offer") of the cancel flow when the user
 * accepts the 50% discount instead of cancelling. Reason+note are
 * the same fields captured in step 1 — we carry them through so the
 * server can record WHICH cancel reason the user was almost canceling
 * for when they accepted the offer. Powers "almost-canceled because X
 * but stayed" analytics.
 *
 * Both fields are optional defensively: if the FE ever invokes the
 * endpoint outside the cancel flow (e.g., a future "give me my
 * discount" button), the captured reason wouldn't be available. */
const NOTE_MAX_LENGTH = 1000;

export class ApplyRetentionDiscountDto {
  @ApiPropertyOptional({ enum: CANCELLATION_REASONS, example: 'too_expensive' })
  @IsOptional()
  @IsIn(CANCELLATION_REASONS as unknown as string[])
  reason?: CancellationReason;

  @ApiPropertyOptional({ maxLength: NOTE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX_LENGTH)
  note?: string;
}
