import { Module } from '@nestjs/common';
import { BillingController } from './controllers/billing.controller';
import { BillingWebhookController } from './controllers/billing-webhook.controller';
import { TranzilaBillingController } from './controllers/tranzila-billing.controller';
import { BillingService } from './services/billing.service';
import { BillingWebhookService } from './services/billing-webhook.service';
import { StripeClientService } from './services/stripe-client.service';
import { SubscriptionSyncService } from './services/subscription-sync.service';
import { TranzilaClassicClient } from './tranzila/tranzila-classic.client';
import { TranzilaBillingService } from './tranzila/tranzila-billing.service';

/* Billing module — Stripe + Tranzila side by side during migration.
 *
 * Stripe surface (existing, unchanged):
 *   POST /billing/checkout, /subscribe, /sync, /portal, /webhook
 *
 * Tranzila surface (Phase 1 Step 2b — trial signup flow):
 *   POST /billing/tranzila/handshake → iframe session params (JWT)
 *   POST /billing/tranzila/notify    → Tranzila → BE callback (@Public)
 *
 * Phase 1 Step 2c adds: run-renewals, cancel, change-plan, update-card.
 * Phase 5 deletes the Stripe pieces.
 *
 * SubscriptionSyncService is still the single writer for
 * user_metadata.subscription_*. Both providers route their writes
 * through it — webhook + in-app subscribe + sync (Stripe) plus
 * handleNotify (Tranzila) — so the contract for what lands on
 * user_metadata is defined in exactly one place. */
@Module({
  controllers: [
    BillingController,
    BillingWebhookController,
    TranzilaBillingController,
  ],
  providers: [
    BillingService,
    BillingWebhookService,
    StripeClientService,
    SubscriptionSyncService,
    TranzilaClassicClient,
    TranzilaBillingService,
  ],
})
export class BillingModule {}
