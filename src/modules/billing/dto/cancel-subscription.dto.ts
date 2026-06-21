import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/* Body for POST /billing/tranzila/cancel.
 *
 * The FE shows a two-step cancellation flow:
 *   1. Reason picker — the user tells us WHY they're cancelling.
 *   2. Final confirm — the user acknowledges grace until period end.
 *
 * Both inputs land here as one request. We store the captured reason
 * in user_metadata.cancellation_reason and (when supplied) the free-
 * text note in user_metadata.cancellation_note, plus a timestamp at
 * user_metadata.cancellation_recorded_at. These are read later by:
 *   - product analytics (churn breakdown by reason)
 *   - the future retention layer (route to a tailored offer based on
 *     the reason, e.g. "too_expensive" → discount, "not_using" →
 *     pause). The retention/discount logic is intentionally NOT in
 *     this turn — only the capture.
 *
 * Reason IDs are English / kebab-case so analytics aren't tied to UI
 * language; Hebrew labels live on the FE only. */
export const CANCELLATION_REASONS = [
  'too_expensive',
  'not_using',
  'missing_feature',
  'temporary_break',
  'switching_tool',
  'other',
] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

const NOTE_MAX_LENGTH = 1000;

export class CancelSubscriptionDto {
  @ApiProperty({ enum: CANCELLATION_REASONS, example: 'too_expensive' })
  @IsIn(CANCELLATION_REASONS as unknown as string[])
  reason!: CancellationReason;

  @ApiPropertyOptional({
    maxLength: NOTE_MAX_LENGTH,
    description:
      'Optional free-text detail. Required-on-FE when reason="other"; the BE accepts any combination.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX_LENGTH)
  note?: string;
}
