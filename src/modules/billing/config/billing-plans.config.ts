import type { PlanId } from '../../quota/config/plans.config';

/* Plan charge amounts + renewal cadence.
 *
 * MUST stay in lock-step with frontend/src/features/billing/config/plans.config.js.
 * The FE's "yearly price" is the monthly-equivalent of an annual
 * subscription (e.g. Starter yearly shows ₪62/mo on the FE = ₪744/year
 * charged once). This config stores the actual charge amount Tranzila
 * sees on each renewal.
 *
 * `amount` is in major units (decimal shekels) — matches Tranzila's `sum`
 * param. Conversion to agorot for the audit row (Int column) happens at
 * insert time.
 *
 * `periodDays` is the renewal interval. The renewal runner advances
 * subscription_current_period_end by this many days × 86400 seconds on
 * each successful charge.
 */

export type BillingCycle = 'monthly' | 'yearly';

export interface BillingPlanAmount {
  /** Major units, decimal shekels. e.g. 129 = ₪129. */
  amount: number;
  /** Days between renewals. */
  periodDays: number;
}

/* Source of truth for the BE side. Frontend mirror is in
 * features/billing/config/plans.config.js (`pricing` block). When you
 * change a price here, change it there too — and the reverse. */
export const BILLING_PLAN_AMOUNTS: Record<PlanId, Record<BillingCycle, BillingPlanAmount>> = {
  starter: {
    monthly: { amount: 129,  periodDays: 30 },
    yearly:  { amount: 744,  periodDays: 365 },  // FE: ₪62/mo × 12
  },
  scale: {
    monthly: { amount: 229,  periodDays: 30 },
    yearly:  { amount: 1428, periodDays: 365 },  // FE: ₪119/mo × 12
  },
  pro: {
    monthly: { amount: 349,  periodDays: 30 },
    yearly:  { amount: 2868, periodDays: 365 },  // FE: ₪239/mo × 12
  },
};

const VALID_CYCLES: readonly BillingCycle[] = ['monthly', 'yearly'];

export function isBillingCycle(value: unknown): value is BillingCycle {
  return typeof value === 'string' && (VALID_CYCLES as readonly string[]).includes(value);
}

/* The ₪1 charge amount used in test mode. Tranzila's trial J5 verify
 * is already ₪1 by convention; reusing that value for test-mode
 * renewals keeps every charge under the J5 hold limit (so real cards
 * won't be settled even on accident). */
export const BILLING_TEST_AMOUNT = 1;

/* Lookup helper. Throws on unknown plan/cycle so a misconfigured user
 * surfaces at the call site rather than silently charging ₪0 or NaN.
 *
 * When `testMode=true`, every plan/cycle pair resolves to a ₪1 charge
 * (period_days is preserved so renewal timing is unaffected — i.e.,
 * a monthly subscriber still renews every 30 days, just for ₪1).
 * Drives the BILLING_TEST_MODE end-to-end test path documented in
 * `env.schema.ts`. */
export function getPlanAmount(
  planId: PlanId,
  cycle: BillingCycle,
  testMode = false,
): BillingPlanAmount {
  const plan = BILLING_PLAN_AMOUNTS[planId];
  if (!plan) {
    throw new Error(`Unknown planId for billing: ${planId}`);
  }
  const entry = plan[cycle];
  if (!entry) {
    throw new Error(`Unknown cycle for plan ${planId}: ${cycle}`);
  }
  if (testMode) {
    return { amount: BILLING_TEST_AMOUNT, periodDays: entry.periodDays };
  }
  return entry;
}
