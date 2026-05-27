import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppConfigService } from '../../../config/config.service';
import {
  BillingCycle,
  PlanId,
  resolveStripePriceId,
} from '../config/stripe-prices.config';
import { StripeClientService } from './stripe-client.service';
import {
  SubscriptionSyncService,
  SyncResult,
} from './subscription-sync.service';
import type { InvoiceListItemDto } from '../dto/invoice-list-item.dto';
import { isValidPlanId } from '../config/stripe-prices.config';
import type Stripe from 'stripe';

const SETTINGS_RETURN_PATH = '/app/settings/payment';
const TRIAL_DAYS = 7;

/* Shape returned to the FE when we can subscribe with a card already on
 * file — the FE shows a confirmation modal with these card details and
 * calls /billing/subscribe to actually create the Subscription. */
export interface SavedCardSummary {
  brand: string;        // 'visa' | 'mastercard' | 'amex' | etc.
  last4: string;
  expMonth: number;
  expYear: number;
  paymentMethodId: string;
}

/* Discriminated response from /billing/checkout. The FE branches on
 * `kind`:
 *   'confirm'  → show in-app confirmation modal, then POST /billing/subscribe
 *   'redirect' → window.location.assign(url) to Stripe Checkout (the
 *                customer has no saved PM, so collection happens there) */
export type CheckoutPreview =
  | { kind: 'confirm'; card: SavedCardSummary }
  | { kind: 'redirect'; url: string };

/* User-facing billing operations.
 *
 * Two public methods today:
 *
 *   createCheckoutSession  — pricing-page "subscribe" flow. Returns a
 *                            Stripe-hosted Checkout URL. FE redirects the
 *                            browser there. After success/cancel, Stripe
 *                            sends the user back to /app/settings/payment
 *                            with a `?checkout=success|cancelled` query
 *                            param that the page can use for toasts.
 *
 *   createPortalSession    — "manage subscription" button. Returns a
 *                            Stripe Customer Portal URL — Stripe hosts
 *                            the entire upgrade/downgrade/cancel/payment-
 *                            method UI. No FE work.
 *
 * Both lazily create the Stripe Customer on first use (mirrors the trial
 * Edge Function pattern) so a user who never subscribes doesn't get a
 * dangling Customer row.
 *
 * 7-day trial is hard-coded on Checkout sessions because the product
 * decision is "trial on every plan signup." Bypass by setting
 * trial_period_days=0 if/when an "immediate-charge upgrade for existing
 * subscribers" path lands.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private supabaseAdminInstance: SupabaseClient | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly stripeClient: StripeClientService,
    private readonly syncService: SubscriptionSyncService,
  ) {}

  async createCheckoutSession(input: {
    userId: string;
    userEmail: string;
    userMetadata: Record<string, unknown>;
    planId: PlanId;
    cycle: BillingCycle;
  }): Promise<CheckoutPreview> {
    const priceId = resolveStripePriceId(this.config, input.planId, input.cycle);
    if (!priceId) {
      throw new BadRequestException(
        `Billing cycle "${input.cycle}" for plan "${input.planId}" is not configured. ` +
          `Set STRIPE_PRICE_${input.planId.toUpperCase()}${
            input.cycle === 'monthly' ? '_MONTHLY' : ''
          } in backend/.env.`,
      );
    }

    const customerId = await this.ensureStripeCustomer({
      userId: input.userId,
      userEmail: input.userEmail,
      userMetadata: input.userMetadata,
    });
    await this.promoteAttachedCardToDefault(customerId);

    /* Saved-card path: when the customer already has a payment method on
     * file (typical for users who came through onboarding's SetupIntent),
     * skip Stripe Checkout entirely. We'd otherwise double-collect the
     * card: Checkout in `mode: 'subscription'` always shows its own card
     * form, even with a PM attached. Instead, return the card summary so
     * the FE can show an in-app confirmation modal, and let the user
     * complete the subscribe via POST /billing/subscribe. */
    const savedCard = await this.getDefaultPaymentMethod(customerId);
    if (savedCard) {
      this.logger.log(
        `Saved-card path: user=${input.userId} plan=${input.planId} card=${savedCard.brand} ••••${savedCard.last4}`,
      );
      return { kind: 'confirm', card: savedCard };
    }

    /* No card on file: fall through to Stripe Checkout. It collects the
     * card AND creates the Subscription in one hosted flow. After the
     * webhook fires, the same card becomes a saved PM and any FUTURE
     * subscribe goes through the in-app path above. */
    const appPublicUrl = this.config.require('APP_PUBLIC_URL');
    const returnBase = `${appPublicUrl}${SETTINGS_RETURN_PATH}`;

    /* metadata on the SESSION ends up on the subscription via the
     * `subscription_data.metadata` field, so the webhook can recover the
     * supabase user id without re-querying the customer. */
    const session = await this.stripeClient.client.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: {
          supabase_user_id: input.userId,
          plan_id: input.planId,
          cycle: input.cycle,
        },
      },
      /* Send the customer back to the same pricing page. The query param
       * is a hint for the FE to show a toast; the real state-of-truth is
       * `user_metadata.subscription_plan_id`, written by the webhook. */
      success_url: `${returnBase}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnBase}?checkout=cancelled`,
      allow_promotion_codes: true,
      /* `auto` lets Stripe pick the locale from the browser's
       * Accept-Language header. Stripe Checkout doesn't currently support
       * Hebrew as a UI locale (the locales list is enumerated), so we
       * can't hard-code 'he' — auto degrades to English for Hebrew users,
       * which is the best available behavior until Stripe adds 'he'. */
      locale: 'auto',
    });

    if (!session.url) {
      throw new Error('Stripe returned a Checkout session without a URL');
    }
    this.logger.log(
      `Checkout created plan=${input.planId} cycle=${input.cycle} user=${input.userId}`,
    );
    return { kind: 'redirect', url: session.url };
  }

  /* Create the Subscription directly via the Stripe API, using the card
   * already on file. Called when the FE confirms the in-app
   * SubscribeConfirmModal — by that point the user has already seen
   * "Subscribe to Scale at ₪229/mo with •••• 4242" and clicked confirm.
   *
   * Side-effects:
   *   1. Sets the chosen PM as the customer's invoice default. Stripe
   *      will auto-charge it when the trial ends. Without this, an
   *      attached-but-not-default PM means the post-trial invoice has no
   *      payment source.
   *   2. Subscription metadata carries supabase_user_id + plan_id + cycle
   *      so the webhook can resolve everything without re-querying the
   *      Customer (same convention as the Checkout flow).
   *
   * The `user_metadata.subscription_*` keys are written by the webhook
   * after `customer.subscription.created` lands — NOT here. Returning
   * early before the webhook fires is intentional: a single writer
   * (the webhook) prevents racing on the same metadata keys. */
  async subscribeWithSavedCard(input: {
    userId: string;
    userEmail: string;
    userMetadata: Record<string, unknown>;
    planId: PlanId;
    cycle: BillingCycle;
  }): Promise<{ subscriptionId: string; trialEndsAt: number | null }> {
    const priceId = resolveStripePriceId(this.config, input.planId, input.cycle);
    if (!priceId) {
      throw new BadRequestException(
        `Billing cycle "${input.cycle}" for plan "${input.planId}" is not configured.`,
      );
    }

    const customerId = await this.ensureStripeCustomer({
      userId: input.userId,
      userEmail: input.userEmail,
      userMetadata: input.userMetadata,
    });

    const savedCard = await this.getDefaultPaymentMethod(customerId);
    if (!savedCard) {
      /* The FE only calls this endpoint after /billing/checkout returned
       * kind=confirm with a card summary — but between that response and
       * the user clicking confirm, the card could have been removed (e.g.
       * via Customer Portal in another tab). Reject cleanly so the FE
       * can fall back to the redirect path. */
      throw new BadRequestException(
        'No payment method on file. Start over from the pricing page to add a card.',
      );
    }

    /* Pin this PM as the invoice default so Stripe charges it after the
     * trial ends. Idempotent — Stripe accepts the same default-PM update
     * across repeated calls. */
    await this.stripeClient.client.customers.update(customerId, {
      invoice_settings: { default_payment_method: savedCard.paymentMethodId },
    });

    const subscription = await this.stripeClient.client.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      default_payment_method: savedCard.paymentMethodId,
      trial_period_days: TRIAL_DAYS,
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      metadata: {
        supabase_user_id: input.userId,
        plan_id: input.planId,
        cycle: input.cycle,
      },
    });

    this.logger.log(
      `Subscription created via saved-card path: user=${input.userId} ` +
        `plan=${input.planId} cycle=${input.cycle} sub=${subscription.id} ` +
        `status=${subscription.status}`,
    );

    /* Write user_metadata.subscription_* INLINE rather than waiting for
     * the webhook. Two reasons:
     *   1. Dev iteration without Stripe CLI / ngrok plumbing — webhook
     *      may not be configured yet, and we still want the FE to see
     *      the new plan immediately.
     *   2. Production safety — webhooks are at-least-once but Stripe
     *      drops events occasionally during incidents. Inline write is
     *      the deterministic path; the webhook (when it fires) just
     *      overwrites with the same values. Idempotent.
     * Failure of this write doesn't fail the subscribe — the subscription
     * exists in Stripe regardless. The FE's post-subscribe sync call
     * (POST /billing/sync) is the backstop. */
    try {
      await this.syncService.writeFromSubscription(subscription);
    } catch (err) {
      this.logger.warn(
        `Inline metadata write after subscribe failed (sub created OK): ${(err as Error).message}`,
      );
    }

    return {
      subscriptionId: subscription.id,
      trialEndsAt: subscription.trial_end ?? null,
    };
  }

  /* Refresh user_metadata.subscription_* from Stripe's view of the
   * customer's subscriptions. Three callers:
   *   1. Manual "refresh subscription" button on the settings page
   *   2. Auto-trigger after Stripe Checkout return (?checkout=success)
   *      — Checkout completes server-to-server with Stripe, the FE has
   *      no idea what landed until it asks
   *   3. Recovery from missed webhooks (operator-invoked)
   *
   * Uses the same writer the webhook does, so the contract is identical.
   * Idempotent — re-sync produces the same end state. */
  /* After onboarding SetupIntent succeeds, pin the card as invoice default
   * on the Stripe Customer the backend owns. SetupIntent attaches the PM
   * but does not set invoice_settings.default_payment_method — without
   * this, /billing/checkout keeps sending users to Stripe Checkout. */
  async finalizePaymentMethod(input: {
    userId: string;
    userEmail: string;
    userMetadata: Record<string, unknown>;
    paymentMethodId?: string;
  }): Promise<{ customerId: string; defaultPaymentMethodId: string | null }> {
    const customerId = await this.ensureStripeCustomer({
      userId: input.userId,
      userEmail: input.userEmail,
      userMetadata: input.userMetadata,
    });

    if (input.paymentMethodId) {
      await this.ensurePaymentMethodOnCustomer(
        input.paymentMethodId,
        customerId,
      );
      await this.stripeClient.client.customers.update(customerId, {
        invoice_settings: { default_payment_method: input.paymentMethodId },
      });
      return {
        customerId,
        defaultPaymentMethodId: input.paymentMethodId,
      };
    }

    await this.promoteAttachedCardToDefault(customerId);
    const card = await this.getDefaultPaymentMethod(customerId);
    return {
      customerId,
      defaultPaymentMethodId: card?.paymentMethodId ?? null,
    };
  }

  async syncForCurrentUser(input: {
    userId: string;
    userEmail: string;
    userMetadata: Record<string, unknown>;
  }): Promise<SyncResult> {
    const customerId = await this.ensureStripeCustomer(input);
    return this.syncService.syncForUser({
      userId: input.userId,
      stripeCustomerId: customerId,
    });
  }

  /* Get the card the customer's invoices will charge against. Two-step:
   *
   *   1. customer.invoice_settings.default_payment_method — the explicit
   *      default. This is what Stripe uses for recurring charges.
   *   2. Fall back to the first card-type PaymentMethod on the customer.
   *      Covers users who came through onboarding's SetupIntent (which
   *      attaches a PM but does NOT set it as invoice default).
   *
   * Returns null if no card-type PM exists — caller falls back to
   * Stripe Checkout to collect one. */
  /** SetupIntent already attaches the PM — only attach when still detached. */
  private async ensurePaymentMethodOnCustomer(
    paymentMethodId: string,
    customerId: string,
  ): Promise<void> {
    const pm =
      await this.stripeClient.client.paymentMethods.retrieve(paymentMethodId);
    const attachedTo =
      typeof pm.customer === 'string' ? pm.customer : pm.customer?.id ?? null;

    if (attachedTo === customerId) return;

    if (attachedTo) {
      throw new BadRequestException(
        'כרטיס האשראי כבר משויך לחשבון אחר. נסו כרטיס אחר.',
      );
    }

    try {
      await this.stripeClient.client.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });
    } catch (err) {
      if (this.isPaymentMethodAlreadyAttached(err)) return;
      throw this.toPaymentMethodHttpError(err);
    }
  }

  private isPaymentMethodAlreadyAttached(err: unknown): boolean {
    const stripe = err as { code?: string; message?: string };
    if (stripe?.code === 'resource_already_exists') return true;
    return /already been attached/i.test(stripe?.message ?? '');
  }

  private toPaymentMethodHttpError(err: unknown): BadRequestException {
    const detail =
      err instanceof Error ? err.message : 'שגיאה בשמירת אמצעי התשלום';
    return new BadRequestException(detail.slice(0, 500));
  }

  private async promoteAttachedCardToDefault(customerId: string): Promise<void> {
    const customer = await this.stripeClient.client.customers.retrieve(customerId);
    if (customer.deleted) return;

    const existing = customer.invoice_settings?.default_payment_method;
    if (existing) return;

    const list = await this.stripeClient.client.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1,
    });
    const pm = list.data[0];
    if (!pm) return;

    await this.stripeClient.client.customers.update(customerId, {
      invoice_settings: { default_payment_method: pm.id },
    });
    this.logger.log(
      `Promoted attached card to default: customer=${customerId} pm=${pm.id}`,
    );
  }

  private async getDefaultPaymentMethod(
    customerId: string,
  ): Promise<SavedCardSummary | null> {
    const customer = await this.stripeClient.client.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });

    if (customer.deleted) return null;

    const defaultPm = customer.invoice_settings?.default_payment_method;
    if (defaultPm && typeof defaultPm !== 'string' && defaultPm.card) {
      return {
        brand: defaultPm.card.brand,
        last4: defaultPm.card.last4,
        expMonth: defaultPm.card.exp_month,
        expYear: defaultPm.card.exp_year,
        paymentMethodId: defaultPm.id,
      };
    }

    /* No default set — fall back to first attached card. limit:1 because
     * we only need to know "is there ANY card?" — the user picked their
     * default at attach time (onboarding) so the first one is reasonable. */
    const list = await this.stripeClient.client.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1,
    });
    const first = list.data[0];
    if (first && first.card) {
      return {
        brand: first.card.brand,
        last4: first.card.last4,
        expMonth: first.card.exp_month,
        expYear: first.card.exp_year,
        paymentMethodId: first.id,
      };
    }

    return null;
  }

  async listInvoices(input: {
    userId: string;
    userEmail: string;
    userMetadata: Record<string, unknown>;
  }): Promise<InvoiceListItemDto[]> {
    const customerId = await this.ensureStripeCustomer(input);
    const { data } = await this.stripeClient.client.invoices.list({
      customer: customerId,
      limit: 50,
    });

    return data
      .filter((inv) => inv.status && inv.status !== 'draft')
      .map((inv) => this.mapStripeInvoice(inv))
      .sort((a, b) => this.parseInvoiceDate(b.date) - this.parseInvoiceDate(a.date));
  }

  async createPortalSession(input: {
    userId: string;
    userEmail: string;
    userMetadata: Record<string, unknown>;
  }): Promise<{ url: string }> {
    const customerId = await this.ensureStripeCustomer(input);
    const appPublicUrl = this.config.require('APP_PUBLIC_URL');

    const session = await this.stripeClient.client.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appPublicUrl}${SETTINGS_RETURN_PATH}`,
    });

    if (!session.url) {
      throw new Error('Stripe returned a Portal session without a URL');
    }
    this.logger.log(`Portal opened user=${input.userId}`);
    return { url: session.url };
  }

  /* Get-or-create the Stripe Customer for this user. The customer id is
   * cached on `user_metadata.stripe_customer_id` (same key the trial
   * Edge Function uses) so both code paths converge on a single Customer
   * per Supabase user — no orphans, no doubles, when both code paths use
   * the same Stripe account + mode.
   *
   * SELF-HEALING: the cached id is verified against Stripe before being
   * returned. If Stripe responds with "resource_missing" (the customer
   * doesn't exist in THIS account/mode — common when the trial Edge
   * Function's STRIPE_SECRET_KEY targets a different account than the
   * backend's, or when test data was wiped), we recreate the customer
   * and overwrite the metadata. The next call sees a valid id and the
   * extra verification round-trip becomes a no-op.
   *
   * The extra retrieve() call costs ~50ms per Checkout/Portal request,
   * which is negligible against the Checkout creation itself (~300ms).
   * The alternative — catching the error at the checkout call site and
   * retrying — leaks Stripe-specific error handling into BillingService's
   * public methods. Eager verification keeps the get-or-create contract
   * clean: "you give me a userId, I give you a working customer id." */
  private async ensureStripeCustomer(input: {
    userId: string;
    userEmail: string;
    userMetadata: Record<string, unknown>;
  }): Promise<string> {
    if (!input.userEmail) {
      throw new UnauthorizedException('User has no email on file');
    }

    const cached = input.userMetadata?.stripe_customer_id;
    if (typeof cached === 'string' && cached.startsWith('cus_')) {
      const verified = await this.verifyCustomer(cached);
      if (verified) return cached;
      this.logger.warn(
        `Cached stripe_customer_id=${cached} is stale (likely from a different ` +
          `Stripe account or mode). Creating a fresh customer for user=${input.userId}.`,
      );
    }

    const customer = await this.stripeClient.client.customers.create({
      email: input.userEmail,
      metadata: { supabase_user_id: input.userId },
    });

    /* Persist back to user_metadata. A failure here doesn't break the
     * current request (we still have the customer id to use right now)
     * but it means the NEXT call will create another Customer — log
     * loudly so we can spot orphan-explosion in metrics. */
    try {
      await this.supabaseAdmin().auth.admin.updateUserById(input.userId, {
        user_metadata: { ...input.userMetadata, stripe_customer_id: customer.id },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist stripe_customer_id for ${input.userId}: ${(err as Error).message}`,
      );
    }

    return customer.id;
  }

  /* Returns true if Stripe knows this customer (and it isn't deleted),
   * false on resource_missing, throws on any other error (network
   * failure, auth failure, etc — those should NOT silently trigger a
   * "let's create a duplicate customer" fallback). */
  private mapStripeInvoice(invoice: Stripe.Invoice): InvoiceListItemDto {
    const meta = invoice.metadata ?? {};
    const planRaw = meta.subscription_plan_id ?? meta.plan_id;
    const cycleRaw = meta.subscription_cycle ?? meta.cycle;
    const planPart =
      typeof planRaw === 'string' && isValidPlanId(planRaw)
        ? this.formatPlanName(planRaw)
        : null;
    const cyclePart =
      typeof cycleRaw === 'string' && (cycleRaw === 'monthly' || cycleRaw === 'yearly')
        ? cycleRaw
        : null;

    let label = [planPart, cyclePart].filter(Boolean).join('-');
    if (!label) {
      const line = invoice.lines?.data?.[0]?.description?.trim();
      label = line || invoice.number || invoice.id;
    }

    const amount =
      invoice.amount_paid ??
      invoice.total ??
      invoice.amount_due ??
      0;
    const currency = invoice.currency ?? 'ils';

    return {
      id: invoice.id,
      label,
      date: this.formatInvoiceDate(invoice.created),
      amount: this.formatInvoiceAmount(amount, currency),
      pdfUrl: invoice.invoice_pdf ?? invoice.hosted_invoice_url ?? null,
    };
  }

  private formatPlanName(planId: string): string {
    return planId.charAt(0).toUpperCase() + planId.slice(1);
  }

  private formatInvoiceDate(unixSeconds: number): string {
    const d = new Date(unixSeconds * 1000);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }

  private parseInvoiceDate(ddMmYyyy: string): number {
    const [dd, mm, yyyy] = ddMmYyyy.split('-').map(Number);
    return new Date(yyyy, mm - 1, dd).getTime();
  }

  private formatInvoiceAmount(amountMinor: number, currency: string): string {
    const major = amountMinor / 100;
    const code = (currency || 'ils').toLowerCase();
    if (code === 'ils') {
      const formatted = major.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
      return `₪${formatted}`;
    }
    return `${major.toFixed(2)} ${code.toUpperCase()}`;
  }

  private async verifyCustomer(customerId: string): Promise<boolean> {
    try {
      const customer = await this.stripeClient.client.customers.retrieve(customerId);
      /* `deleted: true` is Stripe's shape for a soft-deleted customer.
       * Treat it the same as missing. */
      if (customer && (customer as { deleted?: boolean }).deleted) return false;
      return true;
    } catch (err) {
      const raw = err as { type?: string; code?: string; statusCode?: number };
      if (
        raw?.type === 'StripeInvalidRequestError' &&
        (raw?.code === 'resource_missing' || raw?.statusCode === 404)
      ) {
        return false;
      }
      /* Any other error (network, auth, rate-limit) is NOT a "missing
       * customer" signal — re-raise so the user sees a real error rather
       * than silently spawning a duplicate Customer. */
      throw err;
    }
  }

  // Lazy admin client — same pattern as the Storage service. Service-role
  // key bypasses RLS so we can write to user_metadata directly.
  private supabaseAdmin(): SupabaseClient {
    if (this.supabaseAdminInstance) return this.supabaseAdminInstance;
    this.supabaseAdminInstance = createClient(
      this.config.require('SUPABASE_URL'),
      this.config.require('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } },
    );
    return this.supabaseAdminInstance;
  }

  // Re-export for the webhook service so it doesn't need its own admin.
  get adminClient(): SupabaseClient {
    return this.supabaseAdmin();
  }
}
