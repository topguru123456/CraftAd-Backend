import { AppConfigService } from '../../../config/config.service';

/* Plan + cycle → Stripe Price ID lookup.
 *
 * Single source of truth on the BE for "given a planId and a billing cycle,
 * which Stripe Price should we subscribe the customer to?" The FE never
 * sends a raw priceId — that would let any caller pick any Price, including
 * a $0 test one. Instead the FE sends `{ planId, cycle }` from the trusted
 * plans.config.js and the BE resolves to the env-configured Price ID here.
 *
 * Convention:
 *   yearly  → STRIPE_PRICE_{PLAN}             (the plain key)
 *   monthly → STRIPE_PRICE_{PLAN}_MONTHLY
 *
 * Today only the yearly Prices are configured (matching VITE_STRIPE_PRICE_*
 * in the project-root .env). Monthly cycle requests fall through to
 * undefined, which the resolver maps to a clean BadRequest the FE surfaces
 * as "this billing cycle isn't available yet."
 */

export type PlanId = 'starter' | 'scale' | 'pro';
export type BillingCycle = 'yearly' | 'monthly';

const VALID_PLAN_IDS: readonly PlanId[] = ['starter', 'scale', 'pro'];
const VALID_CYCLES: readonly BillingCycle[] = ['yearly', 'monthly'];

export function isValidPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (VALID_PLAN_IDS as readonly string[]).includes(value);
}

export function isValidCycle(value: unknown): value is BillingCycle {
  return typeof value === 'string' && (VALID_CYCLES as readonly string[]).includes(value);
}

/* Resolve to a Stripe Price ID or undefined. Undefined is a normal outcome
 * (cycle not yet sold), not an error — the controller turns it into a 400. */
export function resolveStripePriceId(
  config: AppConfigService,
  planId: PlanId,
  cycle: BillingCycle,
): string | undefined {
  const upper = planId.toUpperCase() as Uppercase<PlanId>;
  if (cycle === 'yearly') {
    return config.get(`STRIPE_PRICE_${upper}` as const);
  }
  return config.get(`STRIPE_PRICE_${upper}_MONTHLY` as const);
}
