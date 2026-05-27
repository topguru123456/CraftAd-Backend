import { Module } from '@nestjs/common';
import { BillingController } from './controllers/billing.controller';
import { BillingWebhookController } from './controllers/billing-webhook.controller';
import { BillingService } from './services/billing.service';
import { BillingWebhookService } from './services/billing-webhook.service';
import { StripeClientService } from './services/stripe-client.service';
import { SubscriptionSyncService } from './services/subscription-sync.service';

/* End-to-end Stripe billing surface:
 *
 *   POST /billing/checkout  → preview: confirm modal or redirect URL
 *   POST /billing/subscribe → in-app subscribe via the saved card
 *   POST /billing/sync      → refresh user_metadata.subscription_* from
 *                             Stripe (used as a webhook backstop and as
 *                             the "manual refresh" button)
 *   POST /billing/portal    → Stripe Customer Portal URL (FE redirects)
 *   POST /billing/webhook   → Stripe → BE; writes user_metadata
 *
 * SubscriptionSyncService is the single writer for user_metadata.subscription_*.
 * Webhook, in-app subscribe, and manual sync all go through it — so the
 * contract for what lands on user_metadata is defined in exactly one place. */
@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [
    BillingService,
    BillingWebhookService,
    StripeClientService,
    SubscriptionSyncService,
  ],
})
export class BillingModule {}
