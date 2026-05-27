import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { AppConfigService } from '../../../config/config.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import type { InvoiceListItemDto } from '../dto/invoice-list-item.dto';
import {
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

  @Post('cancel')
  @ApiBearerAuth('supabase-jwt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel — grace until current period end',
    description:
      'Sets cancel_at_period_end=true on user_metadata. The user retains access ' +
      'until subscription_current_period_end. The renewal runner then sweeps and ' +
      'finalizes the cancellation (subscription_status="canceled", plan keys cleared). ' +
      'Idempotent — calling twice is a no-op.',
  })
  @ApiOkResponse({
    description: 'ok=true plus the period_end timestamp the FE should show the user.',
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ ok: true; periodEndUnix: number | null }> {
    return this.tranzila.cancelSubscription({
      userId: user.id,
      userMetadata: user.metadata ?? {},
    });
  }

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
