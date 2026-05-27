import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/* Body for POST /billing/checkout.
 *
 * The FE sends planId + cycle; the BE resolves to the Stripe Price ID via
 * stripe-prices.config.ts. Validating with IsIn (not a free-form string)
 * prevents callers from trying to subscribe to a plan the system doesn't
 * recognise — bad inputs fail at the validator, not deep in Stripe land. */

export const PLAN_IDS = ['starter', 'scale', 'pro'] as const;
export const BILLING_CYCLES = ['yearly', 'monthly'] as const;

export class CreateCheckoutDto {
  @ApiProperty({ enum: PLAN_IDS, example: 'starter' })
  @IsIn(PLAN_IDS as unknown as string[])
  planId!: (typeof PLAN_IDS)[number];

  @ApiProperty({ enum: BILLING_CYCLES, example: 'yearly' })
  @IsIn(BILLING_CYCLES as unknown as string[])
  cycle!: (typeof BILLING_CYCLES)[number];
}
