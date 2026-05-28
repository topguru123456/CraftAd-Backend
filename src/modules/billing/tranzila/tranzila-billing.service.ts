import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
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

/* Iframe verification amount.
 *
 * ₪1 J5 verify — the industry-safe and Tranzila-canonical value for
 * tokenization without an actual charge. The acquirer authorizes ₪1
 * (placing a temporary hold), no settlement is sent, and the hold
 * auto-reverses within ~3 business days. No money moves.
 *
 * The "₪1.00 to pay" line is hidden from the user by `hidesum=1` in
 * the iframe fields (docs §130: "hide payment sum — it is possible to
 * pass this parameter only if the transaction is made through the
 * token system and only if one of the following variables is sent:
 * tranmode=VK or tranmode=K or tranmode=NK"). Our tranmode=VK matches.
 *
 * Why not sum=0:
 *   - tranmode=AK + sum=0: rejected at submit ("System Error") — A is
 *     a real charge and SHVA cannot settle ₪0.
 *   - tranmode=VK + sum=0: also rejected at submit — every community
 *     port and working integration uses sum > 0 for tokenization. The
 *     iframe RENDERS with sum=0 (which is what the merchant's proof
 *     URL demonstrates) but the actual submission to the acquirer
 *     fails its zero-amount validation.
 *   - tranmode=K + sum=0: would tokenize without J5 auth, but
 *     community ports report higher day-7 decline rates from Israeli
 *     acquirers for K-only tokens. Not worth the risk.
 *
 * Conclusion: sum=1 + hidesum=1 + tranmode=VK is the documented
 * canonical path. */
const VERIFY_SUM_ILS = 1;

const NONCE_TTL_MS = 15 * 60 * 1000;

/* All correlation params get a `craftad_` prefix so Tranzila's notify
 * callback echoes them under a name we recognise as ours. Tranzila
 * passes through any unknown field verbatim — that's the documented
 * pattern across community ports. Exported so the BE return-proxy
 * controller can read the same fields back from the form-POST. */
export const CORRELATION_PREFIX = 'craftad_';

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
    const backendUrl = this.config.require('BACKEND_PUBLIC_URL');
    /* APP_PUBLIC_URL is no longer used in the iframe fields — the
     * front-channel redirects now point at our BE proxy. The proxy
     * (tranzila-billing.controller.ts → returnFromIframe) reads
     * APP_PUBLIC_URL on its own to choose the FE destination. */

    /* No handshake call here. The handshake API (api.tranzila.com/v1/
     * handshake/create) requires Tranzila's paid token module on the
     * terminal — see the docs section "From the moment the HandShake
     * function is activated, you will not be able to process payments
     * without receiving the HandShake token". Our merchant terminal
     * doesn't have it; iframenew.php accepts requests directly when
     * the module is off. If/when the module is purchased, flip a flag
     * and resurrect the call (the client method is still available). */

    const nonce = randomUUID();
    const expiresAt = Date.now() + NONCE_TTL_MS;
    this.putNonce(nonce, {
      userId: input.userId,
      kind: input.kind,
      planId: input.planId,
      cycle: input.cycle,
      expiresAt,
    });

    /* Front-channel redirect targets.
     *
     * Tranzila form-POSTs to success_url_address / fail_url_address
     * after the iframe transition (Tranzila docs §110). Static SPA
     * hosting (Vite dev + Vercel prod) only accepts GET on SPA routes,
     * so we can't point these at the FE directly — that produces 405
     * Method Not Allowed. Instead we point at BE proxy endpoints that
     * accept POST, read the craftad_kind correlation field, and
     * respond 303 See Other → the FE SPA route. The browser then
     * navigates to the FE via GET, the SPA loads, /trial/success
     * postMessages the parent modal.
     *
     * The BE proxy itself is in tranzila-billing.controller.ts. */
    const returnSuccessUrl = `${backendUrl}/billing/tranzila/return/success`;
    const returnFailedUrl = `${backendUrl}/billing/tranzila/return/failed`;

    const fields: Record<string, string> = {
      /* Core iframe params — names match Tranzila docs exactly.
       *
       * tranmode=VK = "J5 verify + tokenize". Issuer authorizes the
       * sum (₪1) as a temporary hold, no settlement is sent, the hold
       * auto-reverses, and Tranzila returns a TranzilaTK we charge on
       * day 7 via tranzila31tk.cgi. */
      sum: VERIFY_SUM_ILS.toFixed(2),
      currency: '1',
      cred_type: '1',
      tranmode: 'VK',
      /* Hides the "₪1.00 to pay" line from the user. Docs §130 allows
       * hidesum only when tranmode ∈ {VK, K, NK} — VK matches. The user
       * sees the card-entry form without a misleading "amount to pay"
       * banner, even though Tranzila's engine still validates against
       * the non-zero sum behind the scenes. */
      hidesum: '1',
      /* `newprocess=1` (3DS V2 forcing, docs §136) is intentionally
       * OMITTED here. The terminal's default 3DS setting applies.
       * Forcing 3DS V2 specifically for a verify-only tokenize flow
       * caused "System Error" at the card-entry transition during
       * Phase 8 testing — the 3DS challenge needs a substantive
       * settlement amount to authenticate against, and the J5 hold
       * isn't that. If a real-charge flow ever needs 3DS V2, add
       * `newprocess=1` to that flow's fields, not here. */
      /* Hebrew iframe UI (per Tranzila docs: lang=il for Israel). */
      lang: 'il',
      /* Wallet buttons. `google_pay` (with underscore) per docs §134;
       * `apple_pay` per merchant confirmation (Apple Pay also needs the
       * domain-association file at .well-known and Tranzila to register
       * the terminal for Apple Pay — that's the merchant's responsibility).
       * The FE iframe element must also carry allowpaymentrequest='true'
       * for the Payment Request API to fire — see TranzilaIframe.jsx. */
      google_pay: '1',
      apple_pay: '1',
      /* URLs */
      success_url_address: returnSuccessUrl,
      fail_url_address: returnFailedUrl,
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
        `plan=${input.planId}/${input.cycle} nonce=${nonce.slice(0, 8)}...`,
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
      cardLast4: extractLast4(body.ccno),
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

  /* --- DEV BYPASS — REMOVE BEFORE PROD -------------------------------
   *
   * Short-circuit the Tranzila iframe for internal testing while real
   * test cards are being coordinated. Gated by TRANZILA_BYPASS_ENABLED.
   * Writes user_metadata as if a real trial tokenize had completed and
   * inserts a clearly-marked billing_payment_attempts row. Never call
   * from prod — the endpoint that exposes this throws when the env
   * flag is false. */
  async bypassTrial(input: {
    userId: string;
  }): Promise<{ ok: true; subscriptionId: string }> {
    if (!this.config.get('TRANZILA_BYPASS_ENABLED')) {
      throw new ForbiddenException(
        'Tranzila bypass is not enabled. Set TRANZILA_BYPASS_ENABLED=true ' +
          'in backend/.env to enable. Production must NEVER set this.',
      );
    }

    const bypassToken = `BYPASS-${randomUUID()}`;
    const planId = 'starter';
    const cycle = 'yearly';

    await this.syncService.writeFromBypass({
      userId: input.userId,
      planId,
      cycle,
      bypassToken,
    });

    /* Audit row so the bypass leaves a paper trail (and so the
     * idempotencyKey unique index sanely accepts repeated bypass calls
     * from the same user — each call generates a new bypass token). */
    try {
      await this.prisma.billingPaymentAttempt.create({
        data: {
          userId: input.userId,
          kind: BillingPaymentAttemptKind.verify,
          amount: 0,
          currency: 'ILS',
          tranzilaIndex: bypassToken,
          responseCode: 'BYPASS',
          rawResponse: 'DEV BYPASS — no Tranzila call made',
          success: true,
          idempotencyKey: `${input.userId}:verify:${bypassToken}`,
        },
      });
    } catch (err) {
      /* P2002 (duplicate idempotency key) is impossible here since we
       * generate a fresh uuid each call, but log defensively. */
      this.logger.warn(`bypass audit row insert failed: ${(err as Error).message}`);
    }

    this.logger.warn(
      `BYPASS used: user=${input.userId} — trial state written without Tranzila call`,
    );

    return { ok: true, subscriptionId: bypassToken };
  }
  /* --- end DEV BYPASS block ---------------------------------------- */

  /* Undo a pending cancellation. Clears cancel_at_period_end so the
   * renewal runner will charge the next period as normal. Idempotent. */
  async resumeSubscription(input: { userId: string }): Promise<{ ok: true }> {
    await this.syncService.resumeTranzilaSubscription({ userId: input.userId });
    return { ok: true };
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

/* Pull the visible last-4 out of Tranzila's masked ccno (e.g. "4580****4580"
 * or "************4580"). Strips non-digits, takes the trailing 4. Returns
 * null if Tranzila didn't send ccno or it had fewer than 4 digits visible. */
function extractLast4(ccno: string | undefined): string | null {
  if (!ccno) return null;
  const digits = ccno.replace(/\D+/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}
