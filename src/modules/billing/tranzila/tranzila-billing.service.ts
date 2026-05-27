import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BillingPaymentAttemptKind } from '@prisma/client';
import { AppConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SubscriptionSyncService } from '../services/subscription-sync.service';
import {
  classifyResponseCode,
  TranzilaClassicClient,
} from './tranzila-classic.client';

/* Tranzila billing orchestrator.
 *
 * Two responsibilities in Phase 1 Step 2b:
 *
 *   initIframeSession  — mints a handshake (thtk) against the charge
 *                        terminal and returns the iframe URL + every
 *                        form field the FE needs to POST. Generates a
 *                        single-use correlation nonce so the notify
 *                        callback can be authoritatively matched to a
 *                        specific user/intent.
 *
 *   handleNotify       — server-to-server callback from Tranzila after
 *                        the iframe finishes. Validates the correlation
 *                        nonce, branches on Response code, writes the
 *                        billing_payment_attempts audit row, persists
 *                        TranzilaTK + expiry to user_metadata, and
 *                        sets subscription_status='trialing' /
 *                        current_period_end=now+7d for trial signups.
 *
 * Renewal sweep + cancel/change-plan/update-card endpoints come in
 * Step 2c. This commit aims for: trial signup works end-to-end.
 *
 * Correlation nonces are stored in an in-memory Map with a 15-minute
 * TTL. Single-instance only — fine for Phase 1 with one Cloud Run
 * instance, will need Redis (or a Postgres table) when we scale to
 * multiple instances. The 15-minute window matches the typical
 * handshake-to-notify latency cap; longer and a user who leaves the
 * iframe open in another tab gets a confusing failure.
 *
 * Wire contract is docs/billing-tranzila.md §3.1 + §4. */

type IframeKind = 'trial' | 'update_card';

interface InitIframeSessionInput {
  userId: string;
  userEmail: string;
  userMetadata: Record<string, unknown>;
  planId: 'starter' | 'scale' | 'pro';
  cycle: 'monthly' | 'yearly';
  kind: IframeKind;
}

export interface IframeSessionResponse {
  /** Form action URL. The FE renders <form action={iframeUrl} target="tranzila" method="POST"> */
  iframeUrl: string;
  /** Hidden form fields. FE iterates this to render <input type="hidden" name={k} value={v}/>. */
  fields: Record<string, string>;
  /** UNIX millis after which the nonce-bound session is invalid. Informational; FE can show "session expired" if a notify never lands. */
  expiresAt: number;
}

interface NonceEntry {
  userId: string;
  kind: IframeKind;
  planId: string;
  cycle: string;
  expiresAt: number;
}

/* J5 verify amount. ₪1 is the industry-safe default for the classic
 * iframe (docs §7 Q3). Auto-reversed by the acquirer; user sees no real
 * charge. If the merchant tells us to switch to ₪0 we change this. */
const VERIFY_SUM_ILS = 1;

const NONCE_TTL_MS = 15 * 60 * 1000;

/* All correlation params get a `craftad_` prefix so Tranzila's notify
 * callback echoes them under a name we recognise as ours. Tranzila
 * passes through any unknown field verbatim — that's the documented
 * pattern across community ports. */
const CORRELATION_PREFIX = 'craftad_';

@Injectable()
export class TranzilaBillingService {
  private readonly logger = new Logger(TranzilaBillingService.name);

  /* In-memory single-use nonce store. See class-level comment for the
   * scaling caveat. Map iteration is O(n) but we cap with a soft cleanup
   * on each put and the TTL keeps the size bounded. */
  private readonly nonces = new Map<string, NonceEntry>();

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly tranzila: TranzilaClassicClient,
    private readonly syncService: SubscriptionSyncService,
  ) {}

  async initIframeSession(input: InitIframeSessionInput): Promise<IframeSessionResponse> {
    const supplier = this.config.require('TRANZILA_TERMINAL_CHARGE');
    const pw = this.config.require('TRANZILA_PW_CHARGE');
    const appUrl = this.config.require('APP_PUBLIC_URL');
    const backendUrl = this.config.require('BACKEND_PUBLIC_URL');

    const thtk = await this.tranzila.createHandshake({
      supplier,
      sum: VERIFY_SUM_ILS,
      pw,
    });

    const nonce = randomUUID();
    const expiresAt = Date.now() + NONCE_TTL_MS;
    this.putNonce(nonce, {
      userId: input.userId,
      kind: input.kind,
      planId: input.planId,
      cycle: input.cycle,
      expiresAt,
    });

    /* Front-channel redirect targets. The Tranzila iframe navigates to
     * these on success/failure. Plan-change return targets live on the
     * payment page; trial returns straight to /app via TrialStartPage's
     * onTrialSuccess once the FE refetches metadata. */
    const successPath =
      input.kind === 'trial'
        ? '/trial/success'
        : '/app/settings/payment?tranzila=card_updated';
    const failPath =
      input.kind === 'trial'
        ? '/trial/failed'
        : '/app/settings/payment?tranzila=card_failed';

    const fields: Record<string, string> = {
      /* Charge params — see docs/billing-tranzila.md §4.2 */
      sum: VERIFY_SUM_ILS.toFixed(2),
      currency: '1',
      cred_type: '1',
      tranmode: 'VK',
      thtk,
      new_process: '1',
      /* Hebrew iframe UI (per Tranzila docs: lang=il for Israel). */
      lang: 'il',
      /* Wallet buttons. Merchant confirmed these flags work (§7 Q2);
       * acquirer-side enablement on the charge terminal is the
       * merchant's responsibility. */
      apple_pay: '1',
      googlepay: '1',
      /* URLs */
      success_url_address: `${appUrl}${successPath}`,
      fail_url_address: `${appUrl}${failPath}`,
      notify_url_address: `${backendUrl}/billing/tranzila/notify`,
      /* Pass-through correlation — Tranzila echoes these back in the
       * notify body verbatim. The nonce + user_id pair authenticates
       * the callback (Tranzila does not HMAC-sign — §4.3). */
      [`${CORRELATION_PREFIX}nonce`]: nonce,
      [`${CORRELATION_PREFIX}user_id`]: input.userId,
      [`${CORRELATION_PREFIX}kind`]: input.kind,
      [`${CORRELATION_PREFIX}plan_id`]: input.planId,
      [`${CORRELATION_PREFIX}cycle`]: input.cycle,
    };

    this.logger.log(
      `iframe session minted: user=${input.userId} kind=${input.kind} ` +
        `plan=${input.planId}/${input.cycle} thtk=${thtk.slice(0, 6)}... ` +
        `nonce=${nonce.slice(0, 8)}...`,
    );

    return {
      iframeUrl: this.tranzila.buildIframeUrl(supplier),
      fields,
      expiresAt,
    };
  }

  /* Handle a Tranzila notify callback.
   *
   * Always responds {ok: true} once we've recorded the attempt — Tranzila
   * doesn't retry on 2xx, and we don't want them retrying our service
   * errors against the same nonce (which is already consumed). The
   * caller HTTP-200s either way; meaningful failure surfaces in our logs
   * and in billing_payment_attempts. The {ok} bool is purely for our
   * own observability, not for Tranzila. */
  async handleNotify(body: Record<string, string>): Promise<{ ok: boolean }> {
    const responseCode = body.Response ?? '';
    const tokenReturned = body.TranzilaTK;
    const expmonth = body.expmonth;
    const expyear = body.expyear;
    const tranzilaIndex = body.index;
    const confirmationCode = body.ConfirmationCode;

    const nonce = body[`${CORRELATION_PREFIX}nonce`];
    const claimedUserId = body[`${CORRELATION_PREFIX}user_id`];
    const claimedKindRaw = body[`${CORRELATION_PREFIX}kind`];
    const claimedPlanId = body[`${CORRELATION_PREFIX}plan_id`];
    const claimedCycle = body[`${CORRELATION_PREFIX}cycle`];

    if (!nonce || !claimedUserId || !this.isIframeKind(claimedKindRaw)) {
      this.logger.warn(
        `notify rejected — missing correlation params (nonce=${!!nonce} userId=${!!claimedUserId} kind=${claimedKindRaw ?? 'missing'})`,
      );
      return { ok: false };
    }
    const claimedKind: IframeKind = claimedKindRaw;

    const entry = this.consumeNonce(nonce);
    if (!entry) {
      this.logger.warn(
        `notify rejected — unknown or expired nonce ${nonce.slice(0, 8)}...`,
      );
      return { ok: false };
    }
    if (entry.userId !== claimedUserId || entry.kind !== claimedKind) {
      this.logger.warn(
        `notify rejected — correlation mismatch (nonce-bound user=${entry.userId} kind=${entry.kind} ` +
          `vs body user=${claimedUserId} kind=${claimedKind})`,
      );
      return { ok: false };
    }

    const classification = classifyResponseCode(responseCode);
    const success = classification === 'success';
    const kindRow: BillingPaymentAttemptKind =
      claimedKind === 'trial'
        ? BillingPaymentAttemptKind.verify
        : BillingPaymentAttemptKind.update_card;

    /* Idempotency key. Prefer Tranzila's transaction index when present;
     * fall back to the nonce so a complete failure (no index returned)
     * still produces a deterministic key — replays of the same body
     * collide on the unique constraint and become no-ops. */
    const idempotencyKey = tranzilaIndex
      ? `${entry.userId}:${kindRow}:${tranzilaIndex}`
      : `${entry.userId}:${kindRow}:nonce:${nonce}`;

    /* J5 verify charges ₪1 = 100 agorot. update_card uses the same
     * verify amount. Renewal rows (Step 2c) will use the plan amount. */
    const amountAgorot = VERIFY_SUM_ILS * 100;

    try {
      await this.prisma.billingPaymentAttempt.create({
        data: {
          userId: entry.userId,
          kind: kindRow,
          amount: amountAgorot,
          currency: 'ILS',
          tranzilaIndex: tranzilaIndex ?? null,
          responseCode: responseCode || null,
          rawResponse: this.summarizeBody(body),
          success,
          idempotencyKey,
          errorMessage: success
            ? null
            : `Tranzila Response=${responseCode || 'empty'} (${classification})`,
        },
      });
    } catch (err) {
      /* Unique-constraint violation on idempotencyKey = duplicate notify.
       * Safe to ignore — the original write was authoritative. */
      const code = (err as { code?: string })?.code;
      if (code === 'P2002') {
        this.logger.log(
          `notify replay (idempotencyKey=${idempotencyKey}); skipping metadata write`,
        );
        return { ok: true };
      }
      throw err;
    }

    if (!success) {
      this.logger.warn(
        `notify recorded failure: user=${entry.userId} kind=${claimedKind} ` +
          `responseCode=${responseCode || 'empty'} class=${classification} ` +
          `index=${tranzilaIndex ?? '-'}`,
      );
      return { ok: true };
    }

    if (!tokenReturned) {
      /* Response=000 but no TranzilaTK is the "shouldn't happen but did"
       * branch. Log loudly so we can spot it in alerting; don't write
       * partial subscription state because the next renewal will have
       * nothing to charge. */
      this.logger.error(
        `notify success without TranzilaTK: user=${entry.userId} ` +
          `kind=${claimedKind} index=${tranzilaIndex ?? '-'}. ` +
          `Skipping metadata write — manual intervention required.`,
      );
      return { ok: true };
    }

    await this.syncService.writeFromTranzilaTokenized({
      userId: entry.userId,
      tranzilaToken: tokenReturned,
      tranzilaTokenExpmonth: expmonth ?? '',
      tranzilaTokenExpyear: expyear ?? '',
      lastTranzilaIndex: tranzilaIndex ?? null,
      lastConfirmationCode: confirmationCode ?? null,
      kind: claimedKind,
      planId: claimedPlanId ?? entry.planId,
      cycle: claimedCycle ?? entry.cycle,
    });

    this.logger.log(
      `notify success: user=${entry.userId} kind=${claimedKind} ` +
        `token=${tokenReturned.slice(0, 6)}... index=${tranzilaIndex ?? '-'} ` +
        `plan=${claimedPlanId ?? entry.planId}/${claimedCycle ?? entry.cycle}`,
    );
    return { ok: true };
  }

  /* User clicks Cancel in-app. Sets cancel_at_period_end=true on
   * user_metadata; access continues until the existing period_end. The
   * renewal runner sees the flag on the next sweep after period_end
   * and finalizes via clearTranzilaSubscription. Idempotent. */
  async cancelSubscription(input: {
    userId: string;
    userMetadata: Record<string, unknown>;
  }): Promise<{ ok: true; periodEndUnix: number | null }> {
    await this.syncService.setTranzilaCancelAtPeriodEnd({ userId: input.userId });
    const periodEnd = input.userMetadata.subscription_current_period_end;
    const periodEndUnix =
      typeof periodEnd === 'number' && Number.isFinite(periodEnd) ? periodEnd : null;
    return { ok: true, periodEndUnix };
  }

  /* User picks a new plan or cycle. No charge today, no proration — the
   * next renewal uses the new amount on the existing period_end schedule.
   * UI must say this clearly. */
  async changePlan(input: {
    userId: string;
    planId: 'starter' | 'scale' | 'pro';
    cycle: 'monthly' | 'yearly';
  }): Promise<{ ok: true }> {
    await this.syncService.updateTranzilaPlan({
      userId: input.userId,
      planId: input.planId,
      cycle: input.cycle,
    });
    return { ok: true };
  }

  private isIframeKind(value: string | undefined): value is IframeKind {
    return value === 'trial' || value === 'update_card';
  }

  private putNonce(nonce: string, entry: NonceEntry): void {
    this.nonces.set(nonce, entry);
    /* Soft cleanup — only walk the map when it grows past a threshold,
     * so single-request latency doesn't scale with stored nonce count. */
    if (this.nonces.size > 1000) this.cleanupExpiredNonces();
  }

  private consumeNonce(nonce: string): NonceEntry | null {
    const entry = this.nonces.get(nonce);
    if (!entry) return null;
    /* Single-use — drop on read regardless of expiry. */
    this.nonces.delete(nonce);
    if (entry.expiresAt < Date.now()) return null;
    return entry;
  }

  private cleanupExpiredNonces(): void {
    const now = Date.now();
    for (const [k, v] of this.nonces) {
      if (v.expiresAt < now) this.nonces.delete(k);
    }
  }

  /* Truncated + redacted body for the audit row. Tranzila already masks
   * ccno but we redact defensively in case the payload format changes.
   * 4KB cap keeps a single row reasonable even if Tranzila ever decides
   * to dump everything. */
  private summarizeBody(body: Record<string, string>): string {
    const redacted: Record<string, string> = { ...body };
    if (redacted.ccno) redacted.ccno = '****';
    const json = JSON.stringify(redacted);
    return json.length > 4000 ? `${json.slice(0, 4000)}…` : json;
  }
}
