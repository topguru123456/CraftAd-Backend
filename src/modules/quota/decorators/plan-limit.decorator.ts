import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { QuotaResource } from '../config/plans.config';
import { PlanLimitGuard } from '../guards/plan-limit.guard';

/* Apply to any create endpoint that should be gated by plan limits:
 *
 *   @Post()
 *   @PlanLimit('brands')
 *   create(@CurrentUser() user, @Body() dto) { ... }
 *
 * The guard runs AFTER JwtAuthGuard (which is global), so `req.user` is
 * populated by the time it counts. Throws 403 with a structured body
 * the FE matches on:
 *
 *   { error: 'plan_limit_reached', resource, planId, current, limit, message }
 *
 * Use this for resources whose *creation* is metered. Read endpoints
 * never get this decorator — quota only gates writes. */

export const PLAN_LIMIT_RESOURCE_KEY = 'planLimitResource';

export const PlanLimit = (resource: QuotaResource) =>
  applyDecorators(
    SetMetadata(PLAN_LIMIT_RESOURCE_KEY, resource),
    UseGuards(PlanLimitGuard),
  );
