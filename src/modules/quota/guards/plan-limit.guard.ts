import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { QuotaResource } from '../config/plans.config';
import { PLAN_LIMIT_RESOURCE_KEY } from '../decorators/plan-limit.decorator';
import { QuotaService } from '../services/quota.service';

/* Plan-limit enforcement guard.
 *
 * Reads the resource off the handler metadata (set by @PlanLimit), looks
 * up the caller's plan from user_metadata.subscription_plan_id, counts
 * their current rows, and throws 403 with a structured body if they're
 * at or over the limit.
 *
 * Runs AFTER JwtAuthGuard (the global guard) — request.user is the
 * AuthenticatedUser shape, not the raw JWT. If the route isn't
 * decorated with @PlanLimit the guard short-circuits to allow (handled
 * by the absence of metadata at the handler level — Nest only attaches
 * the guard when applyDecorators wires it on a specific handler, so
 * this defensive check is belt-and-suspenders).
 *
 * The guard is intentionally non-Global. We opt routes IN via @PlanLimit
 * rather than opt them OUT — security-relevant decisions should be
 * explicit at the call site, not implicit "everything's gated unless
 * marked public." */
@Injectable()
export class PlanLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly quota: QuotaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const resource = this.reflector.get<QuotaResource | undefined>(
      PLAN_LIMIT_RESOURCE_KEY,
      context.getHandler(),
    );
    if (!resource) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      /* If JwtAuthGuard didn't populate user, the request shouldn't have
       * reached us. Reject hard rather than silently allow — failing
       * closed is the safe default for an enforcement guard. */
      return false;
    }

    await this.quota.assertWithinLimit(user.id, user.metadata ?? {}, resource);
    return true;
  }
}
