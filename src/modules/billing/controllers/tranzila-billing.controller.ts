import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { Response } from 'express';
import { AppConfigService } from '../../../config/config.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { ApplyRetentionDiscountDto } from '../dto/apply-retention-discount.dto';
import { CancelSubscriptionDto } from '../dto/cancel-subscription.dto';
import type { InvoiceListItemDto } from '../dto/invoice-list-item.dto';
import {
  CORRELATION_PREFIX,
  IframeSessionResponse,
  TranzilaBillingService,
} from '../tranzila/tranzila-billing.service';
import { TranzilaInvoicesService } from '../tranzila/tranzila-invoices.service';
import {
  RenewalRunSummary,
  TranzilaRenewalRunner,
} from '../tranzila/tranzila-renewal-runner.service';

/* Tranzila billing surface. Wire contract is docs/billing-tranzila.md.
 *
 *   POST /billing/tranzila/handshake    (JWT)  — mint an iframe session
 *   POST /billing/tranzila/notify       (Public, urlencoded) — Tranzila → BE
 *   POST /billing/tranzila/cancel       (JWT)  — grace-cancel until period end
 *   POST /billing/tranzila/change-plan  (JWT)  — switch plan/cycle (next renewal)
 *   POST /billing/tranzila/run-renewals (admin shared-secret) — sweep + charge
 *
 * update-card is the same handshake endpoint called with kind='update_card';
 * no dedicated route needed. The renewal runner picks up the new token
 * on the next sweep automatically.
 */

const PLAN_IDS = ['starter', 'scale', 'pro'] as const;
const BILLING_CYCLES = ['monthly', 'yearly'] as const;
const IFRAME_KINDS = ['trial', 'update_card'] as const;

class InitIframeDto {
  @IsIn(PLAN_IDS as unknown as string[])
  planId!: (typeof PLAN_IDS)[number];

  @IsIn(BILLING_CYCLES as unknown as string[])
  cycle!: (typeof BILLING_CYCLES)[number];

  @IsIn(IFRAME_KINDS as unknown as string[])
  kind!: (typeof IFRAME_KINDS)[number];

  /** Browser origin where the iframe is embedded — must match CORS_ORIGINS. */
  @IsOptional()
  @IsString()
  frontendOrigin?: string;
}

class ChangePlanDto {
  @IsIn(PLAN_IDS as unknown as string[])
  planId!: (typeof PLAN_IDS)[number];

  @IsIn(BILLING_CYCLES as unknown as string[])
  cycle!: (typeof BILLING_CYCLES)[number];
}

@ApiTags('billing-tranzila')
@Controller('billing/tranzila')
export class TranzilaBillingController {
  constructor(
    private readonly tranzila: TranzilaBillingService,
    private readonly runner: TranzilaRenewalRunner,
    private readonly invoices: TranzilaInvoicesService,
    private readonly config: AppConfigService,
  ) {}

  @Post('handshake')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mint a Tranzila iframe session for the current user',
    description:
      'Returns the iframe URL + every form field the FE needs to render and POST. ' +
      'kind=trial for the 7-day-free-trial signup, kind=update_card for replacing ' +
      'the stored token on an active subscription. Single-use 15-minute session — ' +
      'the corresponding notify callback must arrive inside that window.',
  })
  @ApiOkResponse({
    description: 'iframeUrl + flat field map. FE iterates fields to render hidden inputs.',
  })
  async handshake(
    @Body() dto: InitIframeDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<IframeSessionResponse> {
    return this.tranzila.initIframeSession({
      userId: user.id,
      userEmail: user.email ?? '',
      userMetadata: user.metadata ?? {},
      planId: dto.planId,
      cycle: dto.cycle,
      kind: dto.kind,
      frontendOrigin: dto.frontendOrigin,
    });
  }

  /* Tranzila → BE callback. application/x-www-form-urlencoded body
   * parsed by Nest's urlencoded body parser (registered in main.ts).
   *
   * Always returns 200 once the service has acknowledged the request,
   * even on validation failure — Tranzila retries on non-2xx and we'd
   * rather log + discard a bad call than have them hammer us. The
   * service's billing_payment_attempts row is the actual audit signal.
   *
   * @Public because Tranzila has no JWT to send us — auth is via the
   * single-use correlation nonce in the body, validated in the service. */
  @Post('notify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async notify(@Body() body: Record<string, string>): Promise<{ ok: boolean }> {
    return this.tranzila.handleNotify(body ?? {});
  }

  /* Iframe-return proxy.
   *
   * Tranzila form-POSTs to success_url_address / fail_url_address
   * after the iframe transition (Tranzila docs §110). Static SPA hosts
   * (Vite dev, Vercel prod) only accept GET on SPA routes, so POSTing
   * the FE route directly returns 405 Method Not Allowed. This proxy
   * accepts the POST, reads the craftad_kind correlation field to know
   * which flow we're in (trial vs update_card), and responds 303 →
   * the appropriate FE URL. The browser follows the redirect via GET,
   * the SPA loads cleanly, /trial/success or /app/settings/payment
   * postMessages or refreshes per the existing flow.
   *
   * The body itself is discarded — every field Tranzila sends here is
   * also sent to /billing/tranzila/notify (back-channel), where it's
   * actually consumed. This proxy is just about making the redirect
   * work with static SPA hosting.
   *
   * 303 See Other is the correct redirect status for "I received your
   * POST, now make a GET to this new URL". 302 Found is what most
   * browsers do anyway but 303 is explicit per RFC 7231.
   *
   * Open-redirect-safe: `outcome` is constrained to two literals;
   * destinations are constructed from APP_PUBLIC_URL (our env), not
   * from user-controlled body fields. */
  @Post('return/:outcome')
  @Public()
  @ApiExcludeEndpoint()
  async returnFromIframe(
    @Param('outcome') outcome: string,
    @Body() body: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    if (outcome !== 'success' && outcome !== 'failed') {
      throw new BadRequestException(`Unknown outcome: ${outcome}`);
    }
    const appUrl = this.tranzila.resolveFrontendOrigin(
      body?.[`${CORRELATION_PREFIX}frontend_origin`],
    );
    const kind = body?.[`${CORRELATION_PREFIX}kind`];

    let destination: string;
    if (kind === 'update_card') {
      destination =
        outcome === 'success'
          ? `${appUrl}/app/settings/payment?tranzila=card_updated`
          : `${appUrl}/app/settings/payment?tranzila=card_failed`;
    } else {
      /* Default to trial-flow destinations when craftad_kind is
       * missing or unknown. Trial is the dominant flow + the FE
       * /trial/success page also handles the "already trialing"
       * idempotent case gracefully. */
      destination =
        outcome === 'success'
          ? `${appUrl}/trial/success`
          : `${appUrl}/trial/failed`;
    }

    res.redirect(303, destination);
  }

  @Post('cancel')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel — grace until current period end (captures reason)',
    description:
      'Sets cancel_at_period_end=true on user_metadata and persists the ' +
      'cancellation reason + optional note for analytics + future retention ' +
      'routing. The user retains access until subscription_current_period_end; ' +
      'the renewal runner sweeps and finalizes (subscription_status="canceled", ' +
      'plan keys cleared) at the end of the grace period. Idempotent — a second ' +
      'call overwrites the previously-captured reason.',
  })
  @ApiOkResponse({
    description: 'ok=true plus the period_end timestamp the FE should show the user.',
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CancelSubscriptionDto,
  ): Promise<{ ok: true; periodEndUnix: number | null }> {
    return this.tranzila.cancelSubscription({
      userId: user.id,
      userMetadata: user.metadata ?? {},
      reason: dto.reason,
      note: dto.note?.trim() || null,
    });
  }

  @Post('apply-retention-discount')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply the one-time 50% retention discount to the next renewal',
    description:
      "Step 2 of the cancel flow. When the user accepts the discount offer, " +
      'this writes the discount fields on user_metadata + clears any pending ' +
      'cancel state (semantically "accept discount" means "stay subscribed"). ' +
      'One-per-user lifetime — returns 400 if `retention_discount_used` is ' +
      'already true. The renewal runner consumes the discount on the next ' +
      'sweep after period_end.',
  })
  @ApiOkResponse({
    description:
      'ok=true plus the discountPct (always 50), renewalsAffected (always 1), ' +
      "and the existing period_end so the FE can show the user the date the " +
      'discounted charge will land.',
  })
  async applyRetentionDiscount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyRetentionDiscountDto,
  ): Promise<{
    ok: true;
    discountPct: number;
    renewalsAffected: number;
    periodEndUnix: number | null;
  }> {
    return this.tranzila.applyRetentionDiscount({
      userId: user.id,
      userMetadata: user.metadata ?? {},
      acceptanceReason: dto.reason ?? 'unspecified',
      acceptanceNote: dto.note?.trim() || null,
    });
  }

  /* --- DEV BYPASS — REMOVE BEFORE PROD --------------------------------
   * Short-circuits the Tranzila iframe so internal QA can land in the
   * app without real card capture while real test cards are being
   * coordinated. Gated by TRANZILA_BYPASS_ENABLED env (defaults false).
   * The service throws ForbiddenException when the flag is off, so even
   * if the endpoint is reached in prod with the JWT it does nothing.
   * Remove this endpoint (and the corresponding service method +
   * writeFromBypass + runner skip clause + env var) when real test
   * cards are available. */
  @Post('bypass-trial')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async bypassTrial(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ ok: true; subscriptionId: string }> {
    return this.tranzila.bypassTrial({ userId: user.id });
  }
  /* --- end DEV BYPASS block ------------------------------------------ */

  @Post('resume')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo a pending cancellation',
    description:
      'Clears cancel_at_period_end on user_metadata so the renewal runner will ' +
      'charge the next period normally. Used when a user changes their mind during ' +
      'the grace window, or when a canceled user picks a plan again from the ' +
      'pricing grid (which atomically resumes + changes plan). Idempotent.',
  })
  @ApiOkResponse({ description: 'ok=true' })
  async resume(@CurrentUser() user: AuthenticatedUser): Promise<{ ok: true }> {
    return this.tranzila.resumeSubscription({ userId: user.id });
  }

  @Get('invoices')
  @ApiBearerAuth('supabase-jwt')
  @ApiOperation({
    summary: 'List the user\'s Tranzila payment history',
    description:
      'Returns successful renewal charges from billing_payment_attempts, ' +
      'mapped to the InvoiceListItemDto shape the FE table already renders. ' +
      'pdfUrl is null on every row — formal tax invoices (חשבוניות מס) are ' +
      'emailed by Tranzila per transaction when "Auto-document" is enabled ' +
      'on the merchant terminal. Future work will attach Tranzila documents ' +
      'API retrieval keys here.',
  })
  @ApiOkResponse({ description: 'Renewal rows for the settings invoice table.' })
  async listInvoices(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvoiceListItemDto[]> {
    return this.invoices.listForUser(user.id);
  }

  @Post('change-plan')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change plan or cycle — applies on next renewal',
    description:
      'Updates subscription_plan_id and subscription_cycle on user_metadata. ' +
      'No charge today, no proration — the next renewal at the existing ' +
      'subscription_current_period_end uses the new amount. UI must communicate ' +
      'this clearly to avoid confusing the user about when the new price hits.',
  })
  @ApiOkResponse({ description: 'ok=true' })
  async changePlan(
    @Body() dto: ChangePlanDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ ok: true }> {
    return this.tranzila.changePlan({
      userId: user.id,
      planId: dto.planId,
      cycle: dto.cycle,
    });
  }

  /* Renewal sweep. Admin-only — Phase 1 fires this from curl during dev,
   * Phase 5 wires Cloud Scheduler with the same Authorization header.
   *
   * @Public skips the JwtAuthGuard; the inline TRANZILA_ADMIN_SECRET
   * check is the only gate. The secret must be a long random string
   * (env validates min-length 16). */
  @Post('run-renewals')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async runRenewals(
    @Headers('authorization') auth: string | undefined,
  ): Promise<RenewalRunSummary> {
    const expected = this.config.require('TRANZILA_ADMIN_SECRET');
    if (!auth || auth !== `Bearer ${expected}`) {
      throw new UnauthorizedException('Invalid or missing admin secret');
    }
    return this.runner.runRenewals();
  }
}
