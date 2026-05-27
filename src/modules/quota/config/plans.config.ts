/* Plan limit mirror.
 *
 * Mirror of src/features/billing/config/plans.config.js's `limits` field.
 * Kept as a separate file (not imported from the FE) because the FE and
 * BE are separate Vite/Nest projects with no shared workspace package —
 * setting up workspaces just for this 30-line constant is overkill.
 *
 * CONTRACT — these MUST stay in lock-step with the FE. When you add a
 * plan or change a limit:
 *   1. Update src/features/billing/config/plans.config.js
 *   2. Update this file with the same numbers
 *   3. Both files reference the same Stripe price IDs via env (see
 *      backend/.env vs. project-root .env's VITE_STRIPE_PRICE_*), so the
 *      mapping from planId → Stripe Price is already shared across the
 *      two configs.
 *
 * Adding a new resource (e.g. wiring `downloads` enforcement later):
 *   1. Add it to QuotaResource below
 *   2. Add a limit per plan in PLAN_LIMITS
 *   3. Add a counter in QuotaService.countResource
 *   4. Apply @PlanLimit('downloads') to the relevant endpoint
 */

export const PLAN_IDS = ['starter', 'scale', 'pro'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/* Resources that can be quota-gated. `downloads` is declared so the type
 * system knows about it, but enforcement is deferred (per the membership-
 * architecture decision) until the download_events table lands. The
 * limit values below are real and will be respected the moment the BE
 * gets a `downloads` counter wired in. */
export const QUOTA_RESOURCES = ['brands', 'projects', 'avatars', 'downloads'] as const;
export type QuotaResource = (typeof QUOTA_RESOURCES)[number];

/* Sentinel for "no cap". Stays in sync with the FE's `UNLIMITED = Infinity`
 * — JSON serialization isn't a concern because this never crosses the
 * wire; it only matters when a guard compares (count < limit). */
export const UNLIMITED = Number.POSITIVE_INFINITY;

type LimitsByResource = Record<QuotaResource, number>;

export const PLAN_LIMITS: Record<PlanId, LimitsByResource> = {
  starter: { brands: 1, projects: 10, downloads: 20,        avatars: 4 },
  scale:   { brands: 3, projects: 30, downloads: UNLIMITED, avatars: UNLIMITED },
  pro:     { brands: 7, projects: 70, downloads: UNLIMITED, avatars: UNLIMITED },
};

/* Resolve a planId from arbitrary input (the value off user_metadata).
 * Falls back to 'starter' for anything unrecognized — matches the FE's
 * `useCurrentPlan` default so a user with no metadata yet (fresh signup,
 * pre-webhook) gets the same plan on both sides of the wire. */
export function normalizePlanId(value: unknown): PlanId {
  if (typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value)) {
    return value as PlanId;
  }
  return 'starter';
}

export function getPlanLimits(planId: PlanId): LimitsByResource {
  return PLAN_LIMITS[planId];
}
