import { Injectable, Logger } from '@nestjs/common';
import { BillingPaymentAttemptKind } from '@prisma/client';
import { AppConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SubscriptionSyncService } from '../services/subscription-sync.service';
import {
  classifyResponseCode,
} from './tranzila-classic.client';
import { TranzilaApiClient } from './tranzila-api.client';
import {
  BillingCycle,
  getPlanAmount,
  isBillingCycle,
} from '../config/billing-plans.config';
import { normalizePlanId, type PlanId } from '../../quota/config/plans.config';

/* Tranzila renewal runner.
 *
 * Tranzila knows nothing about subscriptions — they hold a token we
 * charge whenever. This runner is the only thing that actually fires
 * recurring charges. Phase 1: invoked manually via
 * POST /billing/tranzila/run-renewals (admin secret).
 * Phase 5: Cloud Scheduler hits the same endpoint hourly.
 *
 * Per sweep, the runner finds every Tranzila subscriber whose
 * subscription_current_period_end has passed, and for each does ONE of:
 *
 *   1. cancel_at_period_end=true → finalize the cancel: clear the
 *      subscription_* keys (clearTranzilaSubscription). No charge.
 *
 *   2. otherwise → charge the stored token for plan_id+cycle's amount.
 *        success     → write_status='active', period_end forward by
 *                      30d (monthly) or 365d (yearly).
 *        terminal    → mark past_due. FE renders update-card banner.
 *                      Period_end stays; next sweep retries until the
 *                      user updates their card (token replaced) or the
 *                      sweep moves to "past_due forever, no further
 *                      attempts" — left as-is for v1, refine in Phase 3.
 *        transient   → leave subscription state untouched. Period_end
 *                      stays. Next sweep retries.
 *
 * Idempotency: every charge attempt INSERTs a billing_payment_attempts
 * row before the HTTP call with `idempotencyKey = userId:renewal:<periodEndIso>`.
 * A second runner racing on the same user/period collides on the unique
 * constraint, gets P2002, and skips. Only one runner charges any given
 * (user, period) pair.
 *
 * "Stuck" recovery: if the charge succeeds but writeFromTranzilaCharge
 * fails (transport / Supabase), the audit row says success=true while
 * user_metadata.period_end is still the old value. Subsequent sweeps
 * see the same user as due, but the idempotencyKey is unchanged → they
 * skip without re-charging. Operator detects via SELECT on attempts
 * WHERE success=true AND created_at > now - 5 min + cross-check with
 * the corresponding user's period_end. Auto-recovery is deferred to a
 * future phase.
 */

interface DueUserRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

export type RenewalOutcome =
  | 'success'
  | 'past_due'
  | 'transient'
  | 'skipped'
  | 'expired';

export interface RenewalRunSummary {
  scanned: number;
  charged: number;
  pastDue: number;
  transient: number;
  expired: number;
  skipped: number;
  errors: { userId: string; message: string }[];
}

const MAX_USERS_PER_SWEEP = 200;

@Injectable()
export class TranzilaRenewalRunner {
  private readonly logger = new Logger(TranzilaRenewalRunner.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly tranzilaApi: TranzilaApiClient,
    private readonly syncService: SubscriptionSyncService,
  ) {}

  async runRenewals(): Promise<RenewalRunSummary> {
    const summary: RenewalRunSummary = {
      scanned: 0,
      charged: 0,
      pastDue: 0,
      transient: 0,
      expired: 0,
      skipped: 0,
      errors: [],
    };

    const due = await this.findDueUsers();
    summary.scanned = due.length;
    this.logger.log(`renewal sweep starting: ${due.length} due user(s)`);

    for (const user of due) {
      try {
        const outcome = await this.processOne(user);
        switch (outcome) {
          case 'success':   summary.charged   += 1; break;
          case 'past_due':  summary.pastDue   += 1; break;
          case 'transient': summary.transient += 1; break;
          case 'expired':   summary.expired   += 1; break;
          case 'skipped':   summary.skipped   += 1; break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`renewal exception for user=${user.id}: ${message}`);
        summary.errors.push({ userId: user.id, message });
      }
    }

    this.logger.log(
      `renewal sweep done: scanned=${summary.scanned} charged=${summary.charged} ` +
        `pastDue=${summary.pastDue} transient=${summary.transient} ` +
        `expired=${summary.expired} skipped=${summary.skipped} errors=${summary.errors.length}`,
    );
    return summary;
  }

  /* Single-user processing. Returns the bucket the user landed in for
   * the summary tally. Throws only on truly unexpected errors (caught
   * by the outer try in runRenewals so the sweep continues). */
  private async processOne(user: DueUserRow): Promise<RenewalOutcome> {
    const metadata = user.metadata ?? {};

    if (metadata.cancel_at_period_end === true) {
      await this.syncService.clearTranzilaSubscription({ userId: user.id });
      return 'expired';
    }

    return this.attemptRenewal(user.id, metadata);
  }

  private async attemptRenewal(
    userId: string,
    metadata: Record<string, unknown>,
  ): Promise<RenewalOutcome> {
    const token = readString(metadata.tranzila_token);
    const expmonth = readString(metadata.tranzila_token_expmonth);
    const expyear = readString(metadata.tranzila_token_expyear);
    const planIdRaw = readString(metadata.subscription_plan_id);
    const cycleRaw = readString(metadata.subscription_cycle);
    const periodEndUnix = readNumber(metadata.subscription_current_period_end);

    if (!token || !expmonth || !expyear || !planIdRaw || !cycleRaw || !periodEndUnix) {
      this.logger.warn(
        `renewal skipped user=${userId} — missing fields ` +
          `(token=${!!token} expm=${!!expmonth} expy=${!!expyear} ` +
          `plan=${planIdRaw ?? '-'} cycle=${cycleRaw ?? '-'} periodEnd=${periodEndUnix ?? '-'})`,
      );
      return 'skipped';
    }

    if (!isBillingCycle(cycleRaw)) {
      this.logger.warn(`renewal skipped user=${userId} — invalid cycle "${cycleRaw}"`);
      return 'skipped';
    }
    const cycle: BillingCycle = cycleRaw;
    const planId: PlanId = normalizePlanId(planIdRaw);

    /* Test mode: env-flag override that pulls every plan's renewal
     * charge to ₪1 (see BILLING_TEST_MODE in env.schema.ts). Lets us
     * exercise the full payment pipeline with real Tranzila
     * transactions at a token cost. Period_days stays normal so
     * renewal timing isn't compressed. */
    const testMode = this.config.get('BILLING_TEST_MODE') === true;
    const { amount: fullAmount, periodDays } = getPlanAmount(planId, cycle, testMode);
    const periodEndDate = new Date(periodEndUnix * 1000);
    const idempotencyKey = `${userId}:renewal:${periodEndDate.toISOString()}`;

    /* Retention-discount window: when retention_discount_pct + remaining
     * are both > 0, this renewal is the one the user accepted the
     * offer for. Charge the discounted amount; on success the runner
     * decrements `renewals_remaining` (clears the pct when it hits 0)
     * via syncService.consumeRetentionDiscount.
     *
     * Math.floor for half-shekel cases (e.g. ₪229 / 2 = ₪114.5 → ₪114)
     * — user benefits from rounding down, matches the FE display math.
     * Math.max(1, ...) enforces a ₪1 floor so the discount can't
     * collapse a test-mode ₪1 charge to ₪0 (which Tranzila rejects). */
    const discountPct = readNumber(metadata.retention_discount_pct);
    const discountRemaining = readNumber(metadata.retention_discount_renewals_remaining);
    const discountActive =
      typeof discountPct === 'number' &&
      discountPct > 0 &&
      discountPct < 100 &&
      typeof discountRemaining === 'number' &&
      discountRemaining > 0;
    const chargeAmount = discountActive
      ? Math.max(1, Math.floor((fullAmount * (100 - discountPct)) / 100))
      : fullAmount;

    /* Pre-insert audit row to claim the idempotency slot. A racing
     * runner doing the same (user, period) collides on idempotency_key
     * and we return 'skipped' without sending a charge. */
    let attemptId: string;
    try {
      const row = await this.prisma.billingPaymentAttempt.create({
        data: {
          userId,
          kind: BillingPaymentAttemptKind.renewal,
          amount: chargeAmount * 100, // major → agorot
          currency: 'ILS',
          periodEnd: periodEndDate,
          idempotencyKey,
          success: false,
        },
        select: { id: true },
      });
      attemptId = row.id;
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        this.logger.log(
          `renewal dedup user=${userId} period=${periodEndDate.toISOString()}`,
        );
        return 'skipped';
      }
      throw err;
    }

    /* Server-side charge via Tranzila API v1 (same terminal that tokenized). */
    const terminal = this.config.require('TRANZILA_TERMINAL_CHARGE');
    const expMonthNum = Number.parseInt(expmonth, 10);
    const expYearNum = normalizeExpYear(expyear);

    let charge;
    try {
      charge = await this.tranzilaApi.chargeWithToken({
        terminalName: terminal,
        token,
        sum: chargeAmount,
        itemName: `${planId} ${cycle} renewal`,
        expireMonth: expMonthNum,
        expireYear: expYearNum,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.billingPaymentAttempt.update({
        where: { id: attemptId },
        data: {
          success: false,
          rawResponse: truncate(message, 4000),
          errorMessage: truncate(`transport: ${message}`, 500),
        },
      });
      this.logger.warn(`renewal transport failure user=${userId}: ${message}`);
      return 'transient';
    }

    const classification = classifyResponseCode(charge.processorResponseCode);
    const success = charge.ok && classification === 'success';

    await this.prisma.billingPaymentAttempt.update({
      where: { id: attemptId },
      data: {
        success,
        responseCode: charge.processorResponseCode || null,
        tranzilaIndex: charge.transactionId ?? null,
        rawResponse: truncate(JSON.stringify(charge.raw), 4000),
        errorMessage: success
          ? null
          : truncate(
              `Tranzila processor=${charge.processorResponseCode || 'empty'} (${classification})`,
              500,
            ),
      },
    });

    if (success) {
      const newPeriodEnd = Math.floor(Date.now() / 1000) + periodDays * 86400;
      await this.syncService.writeFromTranzilaCharge({
        userId,
        status: 'active',
        periodEndUnix: newPeriodEnd,
        lastIndex: charge.transactionId ?? null,
        lastConfirmationCode: charge.authNumber ?? null,
      });
      if (discountActive) {
        await this.syncService.consumeRetentionDiscount({
          userId,
          nextRemaining: (discountRemaining ?? 0) - 1,
        });
      }
      this.logger.log(
        `renewal success user=${userId} plan=${planId}/${cycle} ` +
          `amount=₪${chargeAmount}${discountActive ? ` (after ${discountPct}% retention discount)` : ''} ` +
          `txn=${charge.transactionId ?? '-'} ` +
          `new_period_end=${new Date(newPeriodEnd * 1000).toISOString()}`,
      );
      return 'success';
    }

    if (classification === 'transient' || classification === 'unknown') {
      this.logger.warn(
        `renewal transient user=${userId} code=${charge.processorResponseCode || 'empty'}`,
      );
      return 'transient';
    }

    /* Terminal failure — past_due. Period_end stays unchanged so the
     * user's grace period is "now" (FE shows banner immediately) and
     * the next sweep retries after the user updates their card. */
    await this.syncService.markTranzilaPastDue({
      userId,
      lastErrorCode: charge.processorResponseCode || 'unknown',
    });
    this.logger.warn(
      `renewal terminal user=${userId} code=${charge.processorResponseCode} → past_due`,
    );
    return 'past_due';
  }

  /* Query auth.users via raw SQL for due Tranzila subscribers.
   *
   * Why raw SQL rather than supabaseAdmin.auth.admin.listUsers():
   *   - listUsers paginates 1k at a time with no server-side filter;
   *     filtering in app code re-fetches every user every sweep.
   *   - JSONB-aware WHERE clauses let Postgres scan only matching rows.
   *     A GIN index on raw_user_meta_data speeds this further at
   *     volume; default scan is fine while user counts are modest.
   *
   * Writes still flow through admin.updateUserById (in SubscriptionSyncService)
   * — read with raw SQL, write through the auth-aware admin client. */
  private async findDueUsers(): Promise<DueUserRow[]> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.prisma.$queryRaw<DueUserRow[]>`
      SELECT
        id::text AS id,
        raw_user_meta_data AS metadata
      FROM auth.users
      WHERE
        raw_user_meta_data->>'billing_provider' = 'tranzila'
        AND raw_user_meta_data->>'subscription_status' IN ('trialing', 'active', 'past_due')
        AND COALESCE((raw_user_meta_data->>'subscription_current_period_end')::bigint, 0) <= ${now}
        /* DEV BYPASS — REMOVE BEFORE PROD: skip bypass users whose
         * tokens are synthetic and can't be charged via tranzila31tk.
         * Once the bypass flag is removed this clause becomes a no-op. */
        AND COALESCE(raw_user_meta_data->>'tranzila_bypass', 'false') != 'true'
      ORDER BY (raw_user_meta_data->>'subscription_current_period_end')::bigint NULLS FIRST
      LIMIT ${MAX_USERS_PER_SWEEP}
    `;
    return rows;
  }
}

/* --- small helpers ---------------------------------------------------- */

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeExpYear(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 2030;
  return n >= 2000 ? n : 2000 + n;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
