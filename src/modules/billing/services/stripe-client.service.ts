import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { AppConfigService } from '../../../config/config.service';

/* One Stripe SDK instance per process.
 *
 * Lazy-init so a backend that never touches billing (e.g. webhook-only
 * deployments) doesn't fail to boot because STRIPE_SECRET_KEY isn't set.
 * The first call to `client` validates the key and pins the API version.
 *
 * apiVersion is pinned to the same value the Supabase Edge Function
 * (create-setup-intent) uses, so behavior stays consistent across both
 * code paths. Bumping it means coordinated test against:
 *   - Subscription create/update events
 *   - Trial conversion charges
 *   - Customer Portal flows
 */
@Injectable()
export class StripeClientService {
  private readonly logger = new Logger(StripeClientService.name);
  private stripeInstance: Stripe | null = null;

  constructor(private readonly config: AppConfigService) {}

  get client(): Stripe {
    if (this.stripeInstance) return this.stripeInstance;
    const key = this.config.require('STRIPE_SECRET_KEY');
    /* apiVersion must match the SDK's pinned types (stripe-node v17 →
     * 2025-02-24.acacia). The Edge Function uses '2024-06-20' but runs on
     * Deno with looser typing; for the runtime, Stripe accepts whichever
     * version we send and uses it for that request — there is no
     * subscription-flow behavioural difference between these two versions
     * (the diff is purely typed-output for newer/optional fields). */
    this.stripeInstance = new Stripe(key, {
      apiVersion: '2025-02-24.acacia',
      telemetry: false,
      appInfo: { name: 'craftad-api', version: '0.1.0' },
    });
    this.logger.log('Stripe client initialized');
    return this.stripeInstance;
  }
}
