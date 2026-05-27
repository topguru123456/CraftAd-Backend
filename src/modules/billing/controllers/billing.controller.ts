import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { CreateCheckoutDto } from '../dto/create-checkout.dto';
import type { InvoiceListItemDto } from '../dto/invoice-list-item.dto';
import { BillingService, CheckoutPreview } from '../services/billing.service';
import { SyncResult } from '../services/subscription-sync.service';

/* User-facing billing endpoints. Both require authentication (the
 * app-wide JwtAuthGuard handles that) and return a Stripe-hosted URL
 * that the FE redirects the browser to. No FE-side Stripe.js calls,
 * no embedded forms — Stripe owns the entire collected-payment UI. */
@ApiTags('billing')
@ApiBearerAuth('supabase-jwt')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview a subscribe action for a plan + cycle',
    description:
      'Returns kind=confirm with the saved card summary when the customer ' +
      'already has a payment method on file (FE shows in-app confirmation ' +
      'modal, then calls /billing/subscribe). Otherwise returns kind=redirect ' +
      'with a Stripe Checkout URL (FE redirects to collect a card).',
  })
  @ApiOkResponse({
    description: 'Discriminated by `kind`: "confirm" or "redirect".',
  })
  async checkout(
    @Body() dto: CreateCheckoutDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CheckoutPreview> {
    return this.billing.createCheckoutSession({
      userId: user.id,
      userEmail: user.email ?? '',
      userMetadata: user.metadata ?? {},
      planId: dto.planId,
      cycle: dto.cycle,
    });
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create a Subscription using the card already on file',
    description:
      'Only call this AFTER /billing/checkout returned kind=confirm and the ' +
      'user clicked confirm in the in-app modal. Subscription is created ' +
      'with a 7-day trial, no charge today; `subscription_*` keys on ' +
      'user_metadata are written by the webhook a moment later.',
  })
  @ApiOkResponse({ description: 'Created subscription id + trial end timestamp.' })
  async subscribe(
    @Body() dto: CreateCheckoutDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ subscriptionId: string; trialEndsAt: number | null }> {
    return this.billing.subscribeWithSavedCard({
      userId: user.id,
      userEmail: user.email ?? '',
      userMetadata: user.metadata ?? {},
      planId: dto.planId,
      cycle: dto.cycle,
    });
  }

  @Post('finalize-payment-method')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pin onboarding card as the customer default payment method',
    description:
      'Call after SetupIntent succeeds so /billing/checkout can use the ' +
      'saved-card confirm modal instead of Stripe Checkout.',
  })
  async finalizePaymentMethod(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { paymentMethodId?: string },
  ): Promise<{ customerId: string; defaultPaymentMethodId: string | null }> {
    return this.billing.finalizePaymentMethod({
      userId: user.id,
      userEmail: user.email ?? '',
      userMetadata: user.metadata ?? {},
      paymentMethodId: body.paymentMethodId,
    });
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh user_metadata.subscription_* from Stripe',
    description:
      'Queries Stripe for the caller\'s current subscriptions, picks the ' +
      'most relevant one (active/trialing wins), and writes the result to ' +
      'user_metadata using the same writer the webhook uses. Idempotent. ' +
      'Three real use cases: (1) auto-trigger from the FE after a Stripe ' +
      'Checkout success return, so the cached JWT picks up the new plan ' +
      'without waiting for a webhook; (2) backstop for missed webhooks; ' +
      '(3) "refresh subscription" button on the settings page.',
  })
  @ApiOkResponse({
    description:
      'Summary of what landed: found, planId, cycle, status, subscriptionId. ' +
      'found=false means no Stripe subscription exists for this customer ' +
      '(metadata was cleared accordingly).',
  })
  async sync(@CurrentUser() user: AuthenticatedUser): Promise<SyncResult> {
    return this.billing.syncForCurrentUser({
      userId: user.id,
      userEmail: user.email ?? '',
      userMetadata: user.metadata ?? {},
    });
  }

  @Get('invoices')
  @ApiOperation({
    summary: 'List Stripe invoices for the current customer',
  })
  @ApiOkResponse({ description: 'Invoice rows for the settings invoice table.' })
  async listInvoices(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvoiceListItemDto[]> {
    return this.billing.listInvoices({
      userId: user.id,
      userEmail: user.email ?? '',
      userMetadata: user.metadata ?? {},
    });
  }

  @Post('portal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open the Stripe Customer Portal (manage subscription)',
  })
  @ApiOkResponse({
    description:
      'Customer Portal URL. Stripe hosts the upgrade/downgrade/cancel ' +
      'and payment-method UI; the FE just redirects there.',
  })
  async portal(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ url: string }> {
    return this.billing.createPortalSession({
      userId: user.id,
      userEmail: user.email ?? '',
      userMetadata: user.metadata ?? {},
    });
  }
}
