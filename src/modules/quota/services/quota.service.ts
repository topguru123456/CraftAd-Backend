import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  PlanId,
  QuotaResource,
  UNLIMITED,
  getPlanLimits,
  normalizePlanId,
} from '../config/plans.config';

/* Reads usage + enforces plan limits.
 *
 * Two responsibilities here on purpose — they share the counting logic
 * and a single service keeps the responsibilities discoverable. Splitting
 * into UsageService + EnforcementService would mean two places to extend
 * when a new resource lands.
 *
 * The counts in `getUsage` and `countResource` are Prisma `count`
 * queries — cheap (indexed on user_id for every model that has a
 * userId) and parallelizable. No caching today; if quota checks become
 * a perf hot-spot (unlikely — only fires on create endpoints, not on
 * every read), a short TTL Redis cache per (userId, resource) is the
 * obvious follow-up.
 *
 * Plan resolution intentionally trusts user_metadata.subscription_plan_id
 * without re-validating against Stripe on every request. The Stripe
 * webhook is the ONLY writer to that key (via BillingWebhookService) —
 * so as long as the webhook is healthy, the cached plan_id is current.
 * If the webhook is silently broken, BE enforcement would lag behind
 * reality; we'd notice via "user paid but still hits the free-tier wall"
 * support tickets, which is the correct failure mode.
 */

export interface UsageBreakdown {
  brands: number;
  projects: number;
  avatars: number;
  /* downloads is intentionally omitted from the live counts — there's no
   * `download_events` table yet (deferred per product decision). When it
   * lands, add the count here and the FE quota gate picks it up
   * automatically. */
}

export interface QuotaCheckResult {
  resource: QuotaResource;
  planId: PlanId;
  limit: number;
  current: number;
  unlimited: boolean;
  withinLimit: boolean;
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* Returns counts for every resource the FE quota gate cares about.
   * Parallel reads — Prisma fans them out as one round-trip per query
   * (Postgres handles them concurrently). Total wall time ≈ slowest
   * count, not sum. */
  async getUsage(userId: string): Promise<UsageBreakdown> {
    const [brands, projects, avatars] = await Promise.all([
      this.prisma.brand.count({ where: { userId } }),
      this.prisma.project.count({ where: { userId } }),
      this.prisma.avatar.count({ where: { userId } }),
    ]);
    return { brands, projects, avatars };
  }

  /* Per-resource count. Branches on the resource string rather than
   * dynamic property access on Prisma — keeps the type system happy and
   * gives a clean ENOTSUP for resources we haven't wired yet (downloads). */
  async countResource(userId: string, resource: QuotaResource): Promise<number> {
    switch (resource) {
      case 'brands':
        return this.prisma.brand.count({ where: { userId } });
      case 'projects':
        return this.prisma.project.count({ where: { userId } });
      case 'avatars':
        return this.prisma.avatar.count({ where: { userId } });
      case 'downloads':
        /* No download_events table yet. Returning 0 means "no usage" and
         * the limit check below trivially passes. When the table lands,
         * swap this for the real count and enforcement kicks in
         * automatically. */
        return 0;
    }
  }

  /* Pure plan-vs-count comparison. Doesn't throw — returns the full
   * shape so consumers (logging, debug endpoints) can introspect. */
  async check(
    userId: string,
    metadata: Record<string, unknown> | null | undefined,
    resource: QuotaResource,
  ): Promise<QuotaCheckResult> {
    const planId = normalizePlanId(metadata?.subscription_plan_id);
    const limit = getPlanLimits(planId)[resource];
    const unlimited = limit === UNLIMITED;
    const current = unlimited ? 0 : await this.countResource(userId, resource);
    return {
      resource,
      planId,
      limit,
      current,
      unlimited,
      withinLimit: unlimited || current < limit,
    };
  }

  /* Throws ForbiddenException with a structured body the FE can match
   * on (`error: 'plan_limit_reached'`). Use this from guards or services
   * that need to reject the call entirely.
   *
   * Hebrew message in `message` so the default toast/inline-error
   * surfacing on the FE reads naturally without per-call translation. */
  async assertWithinLimit(
    userId: string,
    metadata: Record<string, unknown> | null | undefined,
    resource: QuotaResource,
  ): Promise<QuotaCheckResult> {
    const result = await this.check(userId, metadata, resource);
    if (!result.withinLimit) {
      this.logger.warn(
        `Plan limit reached user=${userId} resource=${resource} ` +
          `plan=${result.planId} current=${result.current} limit=${result.limit}`,
      );
      throw new ForbiddenException({
        error: 'plan_limit_reached',
        resource: result.resource,
        planId: result.planId,
        current: result.current,
        limit: result.limit,
        message: limitReachedMessage(resource),
      });
    }
    return result;
  }
}

/* Hebrew copy per resource so the message is meaningful out of the box
 * without the FE having to map an error code → string. Keep these short
 * — they render inside toasts and inline errors. */
function limitReachedMessage(resource: QuotaResource): string {
  switch (resource) {
    case 'brands':
      return 'הגעת למכסת המותגים בחבילה שלך. שדרגו את המסלול להמשך.';
    case 'projects':
      return 'הגעת למכסת הפרויקטים בחבילה שלך. שדרגו את המסלול להמשך.';
    case 'avatars':
      return 'הגעת למכסת האווטארים בחבילה שלך. שדרגו את המסלול להמשך.';
    case 'downloads':
      return 'הגעת למכסת ההורדות בחבילה שלך. שדרגו את המסלול להמשך.';
  }
}
