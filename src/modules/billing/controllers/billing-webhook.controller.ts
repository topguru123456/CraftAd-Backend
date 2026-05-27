import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBody,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { BillingWebhookService } from '../services/billing-webhook.service';

/* Stripe webhook receiver.
 *
 * Lives on its own controller (separate from BillingController) so we can:
 *   1. Mark @Public — Stripe authenticates via signature, not JWT.
 *   2. Read the request as raw bytes via @RawBody — signature verification
 *      needs the EXACT bytes Stripe signed, not a JSON-parsed-and-restringified
 *      version (key order + whitespace would break HMAC).
 *
 * The endpoint always responds 200 if the event was dispatched (handled or
 * intentionally ignored). Signature failures or malformed bodies return
 * 400, which signals Stripe to retry — that's the desired behavior because
 * a 400 from us usually means a misconfiguration we want Stripe to keep
 * pinging until it's fixed (vs silently dropping events).
 *
 * Hidden from Swagger (@ApiExcludeController) — it's not part of the
 * public API surface; consumers should not try to POST here.
 */
@ApiExcludeController()
@Controller('billing')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(private readonly webhook: BillingWebhookService) {}

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Headers('stripe-signature') signature: string | undefined,
    @RawBody() rawBody: Buffer | undefined,
  ): Promise<{ ok: true; type: string; handled: boolean }> {
    if (!signature) {
      this.logger.warn('Webhook hit without stripe-signature header');
      throw new BadRequestException('Missing stripe-signature header');
    }
    if (!rawBody || rawBody.length === 0) {
      this.logger.warn('Webhook hit with empty body');
      throw new BadRequestException('Empty body');
    }
    try {
      return await this.webhook.handle(rawBody, signature);
    } catch (err) {
      // Stripe.webhooks.constructEvent throws on signature mismatch.
      // Re-raise as 400 so Stripe retries (per its docs) — we'd rather
      // re-deliver after we fix the secret than silently drop the event.
      const message = err instanceof Error ? err.message : 'webhook failed';
      this.logger.error(`Webhook handling failed: ${message}`);
      throw new BadRequestException(message);
    }
  }
}
