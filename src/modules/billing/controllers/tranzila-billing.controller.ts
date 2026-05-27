import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import {
  IframeSessionResponse,
  TranzilaBillingService,
} from '../tranzila/tranzila-billing.service';

/* Phase 1 Step 2b endpoints — just enough to land a trial signup
 * end-to-end. Renewal-runner / cancel / change-plan / update-card
 * arrive in Step 2c.
 *
 *   POST /billing/tranzila/handshake (JWT)
 *     Mints an iframe session — thtk + every form field the FE needs.
 *
 *   POST /billing/tranzila/notify (@Public, urlencoded)
 *     Tranzila → BE callback when the iframe finishes. Idempotent.
 *
 * Wire contract: docs/billing-tranzila.md §3.1 + §4.
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

@ApiTags('billing-tranzila')
@Controller('billing/tranzila')
export class TranzilaBillingController {
  constructor(private readonly tranzila: TranzilaBillingService) {}

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
}
