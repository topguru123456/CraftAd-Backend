import { Global, Module } from '@nestjs/common';
import { QuotaController } from './controllers/quota.controller';
import { PlanLimitGuard } from './guards/plan-limit.guard';
import { QuotaService } from './services/quota.service';

/* Quota enforcement + reporting.
 *
 * Global so feature modules don't have to import QuotaModule just to use
 * @PlanLimit. The decorator wires the PlanLimitGuard via @UseGuards;
 * Nest resolves the guard through its DI container, which needs the
 * provider visible from the consumer's injection scope. Marking @Global
 * is the cleanest way to make it ambient — same pattern as AuthModule
 * exporting JwtAuthGuard.
 *
 * Exports both:
 *   - QuotaService for any service that wants to assert programmatically
 *     (e.g. in a worker flow that bypasses the controller layer)
 *   - PlanLimitGuard for the @PlanLimit decorator to reference
 */
@Global()
@Module({
  controllers: [QuotaController],
  providers: [QuotaService, PlanLimitGuard],
  exports: [QuotaService, PlanLimitGuard],
})
export class QuotaModule {}
