import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { AppConfigService } from '../../../config/config.service';
import { StripeClientService } from './stripe-client.service';
import { SubscriptionSyncService } from './subscription-sync.service';

/* Stripe webhook handler.
 *
 * Verifies the Stripe signature against the raw request bytes, parses the
 * event, and delegates the subscription mutations to SubscriptionSyncService
 * — the same writer the in-app subscribe path and the explicit /billing/sync
 * endpoint use. One writer, one contract for what lands on user_metadata.
 *
 * Events handled:
 *   customer.subscription.created   First subscribe (or post-trial start)
 *   customer.subscription.updated   Plan change, status change (active/
 *                                   past_due/canceled/trialing transitions)
 *   customer.subscription.deleted   Subscription ended — clear plan, fall
 *                                   back to the FE's starter default
 *
 * Why no `checkout.session.completed` handler: Stripe also fires the
 * subscription.created event when a Checkout-initiated subscription lands,
 * which already carries everything we need. Doubling up would race on
 * user_metadata writes for the same event.
 *
 * Idempotency: each event is written by overwriting the same keys with the
 * latest values from Stripe. Replaying the same event yields the same end
 * state, so Stripe's at-least-once delivery is safe.
 *
 * Loud logging on receipt — every successfully-verified event prints a
 * "webhook event=X id=Y" line BEFORE dispatch. If you're debugging
 * "is Stripe reaching us?" grep for that line; absence = Stripe never
 * reached, presence = we received and processed.
 */

interface WebhookResult {
  ok: true;
  type: string;
  handled: boolean;
}

@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly stripeClient: StripeClientService,
    private readonly sync: SubscriptionSyncService,
  ) {}

  /* Verify signature + dispatch. Throws on signature mismatch (caller
   * surfaces as 400 per Stripe's docs — that signals Stripe to retry).
   *
   * On verification failure we log a structured diagnostic line so the
   * cause is obvious without re-running with extra instrumentation. The
   * line includes:
   *   - secretPrefix: first 12 chars of STRIPE_WEBHOOK_SECRET so you can
   *     verify the env value matches the Stripe endpoint you expect.
   *     Webhook secrets are ~60 chars total; a 12-char prefix is enough
   *     to identify-vs-mismatch without compromising the secret.
   *   - bodyLen + bodyPreview: confirms the raw body reached us intact
   *     (≥500 bytes, starts with `{"id":"evt_`). If bodyLen is 0 or
   *     bodyPreview looks like URL-encoded form data, something reshaped
   *     the request before constructEvent saw it.
   *   - sigPrefix: confirms Stripe sent a normal `t=...,v1=...` header.
   *
   * None of those fields are long-lived secrets — they're either
   * non-secret transport data or secret PREFIXES short enough to
   * identify-vs-not-identify without enabling abuse. */
  async handle(rawBody: Buffer, signature: string): Promise<WebhookResult> {
    const webhookSecret = this.config.require('STRIPE_WEBHOOK_SECRET');

    let event: Stripe.Event;
    try {
      event = this.stripeClient.client.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      const bodyPreview = rawBody
        .toString('utf8')
        .slice(0, 80)
        .replace(/\n/g, '\\n');
      this.logger.error(
        `Signature verification FAILED. ` +
          `Compare these against the Stripe Dashboard endpoint you copied the secret from:\n` +
          `  • secretPrefix=${webhookSecret.slice(0, 12)}... (env STRIPE_WEBHOOK_SECRET)\n` +
          `  • bodyLen=${rawBody.length} bytes\n` +
          `  • bodyPreview=${bodyPreview}\n` +
          `  • sigPrefix=${signature.slice(0, 40)}\n` +
          `Most common cause: the env secret is from a DIFFERENT Stripe webhook ` +
          `endpoint than the one delivering this request. If you have BOTH \`stripe listen\` ` +
          `AND a Dashboard endpoint active, each has its own secret — pick ONE delivery path.`,
      );
      throw err;
    }

    this.logger.log(`webhook event=${event.type} id=${event.id} (signature verified)`);

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.sync.writeFromSubscription(event.data.object as Stripe.Subscription);
        return { ok: true, type: event.type, handled: true };

      case 'customer.subscription.deleted':
        await this.sync.clearForSubscription(event.data.object as Stripe.Subscription);
        return { ok: true, type: event.type, handled: true };

      default:
        // Unhandled events return 200 with handled=false so Stripe stops
        // retrying. We intentionally don't subscribe to every event type
        // in the Stripe Dashboard — only the three above — so this default
        // only fires when someone adds an event type to the endpoint
        // without updating this switch.
        this.logger.debug(`ignored event type=${event.type}`);
        return { ok: true, type: event.type, handled: false };
    }
  }
}
