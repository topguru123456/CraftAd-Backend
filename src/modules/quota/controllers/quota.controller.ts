import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PlanId, normalizePlanId, getPlanLimits } from '../config/plans.config';
import { QuotaService, UsageBreakdown } from '../services/quota.service';

/* Quota usage endpoint.
 *
 * GET /quota/usage returns the caller's current usage AND the limits
 * that apply under their plan. The FE QuotaProvider fetches this on
 * mount to seed the in-app quota gate; calling refresh() re-fetches
 * after a create/delete so the gate stays accurate without per-call
 * round-trips.
 *
 * Returning both usage AND limits in the same payload lets the FE drop
 * its own plan→limit lookup for the gate (the BE is authoritative on
 * limits anyway). The FE plans.config.js stays the source of truth for
 * marketing copy + the upgrade-modal price labels.
 */

interface QuotaUsageResponse {
  planId: PlanId;
  usage: UsageBreakdown;
  limits: {
    brands: number;
    projects: number;
    avatars: number;
    downloads: number;
  };
}

@ApiTags('quota')
@ApiBearerAuth('supabase-jwt')
@Controller('quota')
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  @Get('usage')
  @ApiOperation({
    summary: "Caller's current usage + the limits that apply under their plan",
  })
  @ApiOkResponse({
    description:
      'Plan id (resolved from user_metadata.subscription_plan_id, defaults ' +
      'to "starter"), live counts for brands/projects/avatars, and the ' +
      'numeric limits per resource. Infinity is returned as `null` so JSON ' +
      'serialization stays clean.',
  })
  async getUsage(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<QuotaUsageResponse> {
    const planId = normalizePlanId(user.metadata?.subscription_plan_id);
    const [usage, planLimits] = await Promise.all([
      this.quota.getUsage(user.id),
      Promise.resolve(getPlanLimits(planId)),
    ]);

    return {
      planId,
      usage,
      /* Infinity → null over the wire (JSON has no Infinity literal,
       * stringifying it yields `null` anyway but being explicit here
       * documents the contract for the FE). */
      limits: {
        brands:    finiteOrNull(planLimits.brands),
        projects:  finiteOrNull(planLimits.projects),
        avatars:   finiteOrNull(planLimits.avatars),
        downloads: finiteOrNull(planLimits.downloads),
      },
    };
  }
}

/* JSON-safe limit projection. Finite → the number, Infinity → null.
 * Consumers treat null as "unlimited". */
function finiteOrNull(n: number): number {
  return Number.isFinite(n) ? n : (null as unknown as number);
}
