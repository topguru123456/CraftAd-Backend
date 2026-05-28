import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { AppConfigService } from '../../../config/config.service';
import { StripeClientService } from './stripe-client.service';

/* Single source of truth for "given a Stripe Subscription, write the
 * relevant fields onto Supabase user_metadata".
 *
 * Two callers today:
 *   1. BillingWebhookService — on customer.subscription.created/updated,
 *      the webhook payload IS the Subscription; pass it straight to
 *      `writeFromSubscription`.
 *   2. BillingService.subscribeWithSavedCard — right after the in-app
 *      subscribe creates a Subscription, write the metadata inline so
 *      the FE doesn't have to wait for the webhook round-trip (or for
 *      a webhook to even be configured — useful in dev).
 *
 * And one explicit-trigger caller:
 *   3. POST /billing/sync — `syncForUser(userId)` queries Stripe for the
 *      caller's most relevant subscription and writes the result. Acts
 *      as a backstop for missed webhooks AND as the "refresh from
 *      Stripe" button on the settings page.
 *
 * All three converge through the SAME writer (`patchUserMetadata`), so
 * the contract for what lands on user_metadata is defined in exactly
 * one place. Mismatches between the webhook flow and any other path
 * are impossible by construction.
 *
 * Status-handling note: when a customer has multiple subscriptions
 * (rare — happens if a previous attempt was cancelled then a new one
 * started), `syncForUser` picks the one in the "most active" status,
 * preferring active/trialing over past_due/canceled/incomplete. This
 * matches user expectation ("what plan am I on") better than just
 * taking the most-recently-created.
 */

/* Status priority — higher score = "more current". Used to pick the
 * canonical subscription when a customer has multiple. */
const STATUS_PRIORITY: Record<string, number> = {
  active:             5,
  trialing:           5,
  past_due:           4,
  unpaid:             3,
  incomplete:         2,
  incomplete_expired: 1,
  canceled:           0,
  paused:             0,
};

export interface SyncResult {
  found: boolean;
  planId: string | null;
  cycle: string | null;
  status: string | null;
  subscriptionId: string | null;
}

@Injectable()
export class SubscriptionSyncService {
  private readonly logger = new Logger(SubscriptionSyncService.name);
  private supabaseAdminInstance: SupabaseClient | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly stripeClient: StripeClientService,
  ) {}

  /* Write the given Subscription onto user_metadata. The subscription
   * MUST carry `supabase_user_id` in metadata (set at subscribe time);
   * subscriptions created outside our app would need a separate
   * customer-to-user lookup, not done here today. */
  async writeFromSubscription(subscription: Stripe.Subscription): Promise<void> {
    const userId = this.extractSupabaseUserId(subscription);
    if (!userId) return;

    const planId = subscription.metadata?.plan_id ?? this.derivePlanIdFromPriceId(
      subscription.items?.data?.[0]?.price?.id,
    );
    const cycle = subscription.metadata?.cycle ?? this.deriveCycleFromSubscription(subscription);

    await this.patchUserMetadata(userId, {
      subscription_plan_id: planId,
      subscription_cycle: cycle,
      subscription_status: subscription.status,
      subscription_id: subscription.id,
      subscription_current_period_end: subscription.current_period_end,
    });

    this.logger.log(
      `metadata written: user=${userId} plan=${planId} cycle=${cycle} status=${subscription.status}`,
    );
  }

  /* Tranzila tokenize → metadata writer.
   *
   * Sibling of writeFromSubscription, but for the Tranzila path. Called
   * by TranzilaBillingService.handleNotify on a successful Response=000
   * notify with a TranzilaTK present (i.e. iframe tokenize succeeded).
   *
   * Two kinds:
   *   'trial'       — first tokenize at signup. Sets subscription_status
   *                   to 'trialing', mints a new subscription_id, sets
   *                   current_period_end to now+7 days.
   *   'update_card' — replacement card during an active subscription.
   *                   Replaces the stored token + exp; subscription
   *                   state (plan, cycle, status, period_end) is left
   *                   untouched so the next renewal charges the new
   *                   card on the existing schedule.
   *
   * Metadata keys written:
   *   billing_provider                    — 'tranzila' (mirror, helpful for the FE)
   *   tranzila_token                      — TranzilaTK from the notify
   *   tranzila_token_expmonth/_expyear    — MM / YY for tranzila31tk.cgi
   *   tranzila_last_index                 — Tranzila transaction id (for refund/audit)
   *   tranzila_last_confirmation_code     — auth code, for invoice display
   *   subscription_*                      — see kind branches above
   *
   * Idempotent: re-firing with the same TranzilaTK overwrites the same
   * keys with the same values; the audit row's unique idempotencyKey
   * keeps duplicate notifies from creating duplicate attempt rows. */
  async writeFromTranzilaTokenized(input: {
    userId: string;
    tranzilaToken: string;
    tranzilaTokenExpmonth: string;
    tranzilaTokenExpyear: string;
    /** Last 4 digits of the PAN, extracted from notify's masked ccno. Null if Tranzila didn't send ccno. */
    cardLast4: string | null;
    lastTranzilaIndex: string | null;
    lastConfirmationCode: string | null;
    kind: 'trial' | 'update_card';
    planId: string;
    cycle: string;
  }): Promise<void> {
    const patch: Record<string, unknown> = {
      billing_provider: 'tranzila',
      tranzila_token: input.tranzilaToken,
      tranzila_token_expmonth: input.tranzilaTokenExpmonth || null,
      tranzila_token_expyear: input.tranzilaTokenExpyear || null,
      tranzila_card_last4: input.cardLast4,
      tranzila_last_index: input.lastTranzilaIndex,
      tranzila_last_confirmation_code: input.lastConfirmationCode,
    };

    if (input.kind === 'trial') {
      /* 7-day no-charge trial. current_period_end in UNIX seconds matches
       * Stripe's format so useSubscriptionInfo on the FE doesn't branch. */
      const TRIAL_DAYS = 7;
      const periodEnd = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 86400;
      patch.subscription_id = `tz_${randomUUID()}`;
      patch.subscription_plan_id = input.planId;
      patch.subscription_cycle = input.cycle;
      patch.subscription_status = 'trialing';
      patch.subscription_current_period_end = periodEnd;
      patch.cancel_at_period_end = false;
    }

    await this.patchUserMetadata(input.userId, patch);
    this.logger.log(
      `tranzila tokenize written: user=${input.userId} kind=${input.kind} ` +
        `plan=${input.planId}/${input.cycle}`,
    );
  }

  /* Renewal charge succeeded → advance period_end and mark active.
   *
   * Called by TranzilaRenewalRunner after a Response=000 from
   * tranzila31tk.cgi. Only the per-charge fields move; plan_id and
   * cycle stay put (those change via updateTranzilaPlan). */
  async writeFromTranzilaCharge(input: {
    userId: string;
    status: 'active' | 'past_due';
    periodEndUnix: number;
    lastIndex: string | null;
    lastConfirmationCode: string | null;
  }): Promise<void> {
    await this.patchUserMetadata(input.userId, {
      subscription_status: input.status,
      subscription_current_period_end: input.periodEndUnix,
      tranzila_last_index: input.lastIndex,
      tranzila_last_confirmation_code: input.lastConfirmationCode,
    });
    this.logger.log(
      `tranzila renewal written: user=${input.userId} status=${input.status} ` +
        `period_end=${new Date(input.periodEndUnix * 1000).toISOString()}`,
    );
  }

  /* Terminal renewal failure → flip to past_due. The renewal runner
   * keeps trying on subsequent sweeps; the FE renders an update-card
   * banner driven off subscription_status='past_due'. */
  async markTranzilaPastDue(input: {
    userId: string;
    lastErrorCode: string;
  }): Promise<void> {
    await this.patchUserMetadata(input.userId, {
      subscription_status: 'past_due',
      tranzila_last_error_code: input.lastErrorCode,
    });
    this.logger.warn(
      `tranzila past_due: user=${input.userId} lastErrorCode=${input.lastErrorCode}`,
    );
  }

  /* User canceled and their current_period_end has now passed → finalize
   * the cancellation. Clears the per-subscription keys but keeps the
   * token around in case they resubscribe (one less iframe round-trip). */
  async clearTranzilaSubscription(input: { userId: string }): Promise<void> {
    await this.patchUserMetadata(input.userId, {
      subscription_status: 'canceled',
      subscription_plan_id: null,
      subscription_cycle: null,
      subscription_id: null,
      subscription_current_period_end: null,
      cancel_at_period_end: false,
    });
    this.logger.log(`tranzila subscription cleared: user=${input.userId}`);
  }

  /* User clicked Cancel in-app. Sets the grace flag; access continues
   * until the existing period_end, at which point the renewal runner
   * sweeps and clearTranzilaSubscription() finalizes. Idempotent — calling
   * twice writes the same value. */
  async setTranzilaCancelAtPeriodEnd(input: { userId: string }): Promise<void> {
    await this.patchUserMetadata(input.userId, {
      cancel_at_period_end: true,
    });
    this.logger.log(`tranzila cancel-at-period-end set: user=${input.userId}`);
  }

  /* User changed their mind during the grace window — clear the flag.
   * The renewal runner will charge them as normal on the next sweep.
   * Idempotent — calling on a non-canceled user writes the same false. */
  async resumeTranzilaSubscription(input: { userId: string }): Promise<void> {
    await this.patchUserMetadata(input.userId, {
      cancel_at_period_end: false,
    });
    this.logger.log(`tranzila resume: user=${input.userId}`);
  }

  /* --- DEV BYPASS — REMOVE BEFORE PROD -------------------------------
   *
   * Marks the user as if a real Tranzila trial tokenize had completed.
   * Used by the bypass endpoint while we wait for real merchant-
   * provided test cards. The metadata layout matches what
   * writeFromTranzilaTokenized produces, plus a `tranzila_bypass: true`
   * marker the renewal runner uses to skip these users.
   *
   * The token is a synthetic value starting with `BYPASS-` so it's
   * instantly recognizable in DB inspection and clearly never going
   * to charge anything via `tranzila31tk.cgi`. */
  async writeFromBypass(input: {
    userId: string;
    planId: string;
    cycle: string;
    bypassToken: string;
  }): Promise<void> {
    const TRIAL_DAYS = 7;
    const periodEnd = Math.floor(Date.now() / 1000) + TRIAL_DAYS * 86400;
    await this.patchUserMetadata(input.userId, {
      billing_provider: 'tranzila',
      tranzila_bypass: true,
      tranzila_token: input.bypassToken,
      tranzila_token_expmonth: '12',
      tranzila_token_expyear: '99',
      tranzila_card_last4: '0000',
      tranzila_last_index: input.bypassToken,
      tranzila_last_confirmation_code: 'BYPASS',
      subscription_id: `tz_bypass_${randomUUID()}`,
      subscription_plan_id: input.planId,
      subscription_cycle: input.cycle,
      subscription_status: 'trialing',
      subscription_current_period_end: periodEnd,
      cancel_at_period_end: false,
    });
    this.logger.warn(
      `BYPASS trial tokenize written: user=${input.userId} plan=${input.planId}/${input.cycle} ` +
        `— this user is in DEV BYPASS mode and renewals will be SKIPPED`,
    );
  }
  /* --- end DEV BYPASS block ---------------------------------------- */

  /* In-app plan change. No proration in v1 — the next renewal uses the
   * new amount on the existing period_end schedule. */
  async updateTranzilaPlan(input: {
    userId: string;
    planId: string;
    cycle: string;
  }): Promise<void> {
    await this.patchUserMetadata(input.userId, {
      subscription_plan_id: input.planId,
      subscription_cycle: input.cycle,
    });
    this.logger.log(
      `tranzila plan changed: user=${input.userId} plan=${input.planId}/${input.cycle}`,
    );
  }

  /* Clear all subscription_* keys. Called when a Subscription is fully
   * deleted (canceled at period end + period rolled over). The FE
   * `useCurrentPlan` defaults back to 'starter' / 'monthly' when these
   * are absent, so this reverts the user to the free tier. */
  async clearForSubscription(subscription: Stripe.Subscription): Promise<void> {
    const userId = this.extractSupabaseUserId(subscription);
    if (!userId) return;
    await this.patchUserMetadata(userId, {
      subscription_plan_id: null,
      subscription_cycle: null,
      subscription_status: 'canceled',
      subscription_id: null,
      subscription_current_period_end: null,
    });
    this.logger.log(`metadata cleared: user=${userId} (subscription ${subscription.id} deleted)`);
  }

  /* Explicit-trigger sync: query Stripe for ALL of this customer's
   * subscriptions, pick the canonical one, write it. Returns a small
   * summary the controller can echo back to the FE for diagnostics.
   *
   * Idempotent — calling it a hundred times yields the same end state.
   * Safe to expose as a public API endpoint without rate-limiting (one
   * Stripe list call + one user_metadata write per invocation). */
  async syncForUser(input: {
    userId: string;
    stripeCustomerId: string;
  }): Promise<SyncResult> {
    const subs = await this.stripeClient.client.subscriptions.list({
      customer: input.stripeCustomerId,
      status: 'all',
      limit: 10,
      expand: ['data.items.data.price'],
    });

    if (subs.data.length === 0) {
      /* No subscriptions on record. Clear any cached metadata so the
       * FE doesn't continue showing a stale plan. */
      await this.patchUserMetadata(input.userId, {
        subscription_plan_id: null,
        subscription_cycle: null,
        subscription_status: null,
        subscription_id: null,
        subscription_current_period_end: null,
      });
      this.logger.log(`sync: user=${input.userId} has no subscriptions; metadata cleared`);
      return { found: false, planId: null, cycle: null, status: null, subscriptionId: null };
    }

    const canonical = this.pickCanonical(subs.data);

    /* Ensure the supabase_user_id is on the sub metadata so subsequent
     * webhook deliveries for this subscription can resolve back to the
     * Supabase user without a customer round-trip. Subscriptions created
     * via our Checkout flow already carry this; old / Dashboard-created
     * ones may not — backfill defensively. */
    if (canonical.metadata?.supabase_user_id !== input.userId) {
      try {
        await this.stripeClient.client.subscriptions.update(canonical.id, {
          metadata: { ...(canonical.metadata ?? {}), supabase_user_id: input.userId },
        });
        canonical.metadata = { ...(canonical.metadata ?? {}), supabase_user_id: input.userId };
      } catch (err) {
        this.logger.warn(
          `Failed to backfill supabase_user_id on subscription ${canonical.id}: ${(err as Error).message}`,
        );
      }
    }

    await this.writeFromSubscription(canonical);

    return {
      found: true,
      planId: canonical.metadata?.plan_id
        ?? this.derivePlanIdFromPriceId(canonical.items?.data?.[0]?.price?.id),
      cycle: canonical.metadata?.cycle
        ?? this.deriveCycleFromSubscription(canonical),
      status: canonical.status,
      subscriptionId: canonical.id,
    };
  }

  /* Pick the most-relevant sub when a customer has multiple. Active/
   * trialing wins outright; among ties, the most recently created
   * sub wins. */
  private pickCanonical(subs: Stripe.Subscription[]): Stripe.Subscription {
    return [...subs].sort((a, b) => {
      const ap = STATUS_PRIORITY[a.status] ?? 0;
      const bp = STATUS_PRIORITY[b.status] ?? 0;
      if (ap !== bp) return bp - ap;
      return (b.created ?? 0) - (a.created ?? 0);
    })[0];
  }

  private extractSupabaseUserId(subscription: Stripe.Subscription): string | null {
    const fromSub = subscription.metadata?.supabase_user_id;
    if (typeof fromSub === 'string' && fromSub.length > 0) return fromSub;
    const customer = subscription.customer;
    if (typeof customer === 'object' && customer && 'metadata' in customer) {
      const fromCust = customer.metadata?.supabase_user_id;
      if (typeof fromCust === 'string' && fromCust.length > 0) return fromCust;
    }
    this.logger.warn(
      `subscription ${subscription.id} has no supabase_user_id metadata; skipping write`,
    );
    return null;
  }

  /* Reverse-lookup price ID → planId via env config. Used when the
   * subscription doesn't carry our `plan_id` metadata (Dashboard-created
   * subs, legacy migration, etc). Falls back to 'starter' so the FE
   * always has a valid plan to render. */
  private derivePlanIdFromPriceId(priceId: string | undefined): string {
    if (!priceId) return 'starter';
    const candidates = [
      ['starter', this.config.get('STRIPE_PRICE_STARTER')],
      ['starter', this.config.get('STRIPE_PRICE_STARTER_MONTHLY')],
      ['scale',   this.config.get('STRIPE_PRICE_SCALE')],
      ['scale',   this.config.get('STRIPE_PRICE_SCALE_MONTHLY')],
      ['pro',     this.config.get('STRIPE_PRICE_PRO')],
      ['pro',     this.config.get('STRIPE_PRICE_PRO_MONTHLY')],
    ] as const;
    for (const [name, envValue] of candidates) {
      if (envValue && envValue === priceId) return name;
    }
    return 'starter';
  }

  private deriveCycleFromSubscription(
    subscription: Stripe.Subscription,
  ): 'monthly' | 'yearly' {
    const interval = subscription.items?.data?.[0]?.price?.recurring?.interval;
    return interval === 'year' ? 'yearly' : 'monthly';
  }

  /* Merge-write — reads current first so we don't clobber fields we
   * don't own (stripe_customer_id, onboarding, brand metadata, etc). */
  private async patchUserMetadata(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const admin = this.supabaseAdmin();
    const { data: { user }, error: getError } = await admin.auth.admin.getUserById(userId);
    if (getError || !user) {
      this.logger.warn(`Cannot patch user_metadata for ${userId}: ${getError?.message ?? 'no user'}`);
      return;
    }
    const merged = { ...(user.user_metadata ?? {}), ...patch };
    const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
      user_metadata: merged,
    });
    if (updateError) {
      this.logger.error(`Failed to patch user_metadata for ${userId}: ${updateError.message}`);
      throw new Error(updateError.message);
    }
  }

  private supabaseAdmin(): SupabaseClient {
    if (this.supabaseAdminInstance) return this.supabaseAdminInstance;
    this.supabaseAdminInstance = createClient(
      this.config.require('SUPABASE_URL'),
      this.config.require('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } },
    );
    return this.supabaseAdminInstance;
  }
}
