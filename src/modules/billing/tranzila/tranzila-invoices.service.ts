import { Injectable, Logger } from '@nestjs/common';
import { BillingPaymentAttempt, BillingPaymentAttemptKind } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { InvoiceListItemDto } from '../dto/invoice-list-item.dto';
import {
  BILLING_PLAN_AMOUNTS,
  type BillingCycle,
} from '../config/billing-plans.config';
import type { PlanId } from '../../quota/config/plans.config';

/* Tranzila "invoices" surface — backed by the billing_payment_attempts
 * audit table.
 *
 * What this is and isn't:
 *
 *   IS  — a payment-history view: every successful renewal charge made
 *         against the user's Tranzila token, oldest-to-newest, mapped
 *         into the same InvoiceListItemDto shape the existing
 *         InvoicesTable component already renders.
 *
 *   ISN'T — formal tax invoices (חשבוניות מס). Israeli tax compliance
 *         is the merchant's responsibility; Tranzila auto-generates +
 *         emails the tax invoice to the customer per transaction when
 *         "Auto-document" is enabled on the terminal. We don't ship
 *         PDFs here — every row's pdfUrl is null. The UI surfaces a
 *         "tax invoices via email" note so users know where to find
 *         the real document.
 *
 * Future Phase 4.5 (when needed): call billing5.tranzila.com's
 * documents_db.get_document to attach real PDF retrieval keys per row.
 * Phase 0 Q8 (auth model for billing5.*) needs to be resolved with the
 * merchant before that lands.
 *
 * Filter rules:
 *   - kind = 'renewal' only. 'verify' (₪1 J5) and 'update_card' rows
 *     are operational events, not real charges — showing them would
 *     confuse users who never see the ₪1 hit their statement (it
 *     auto-reverses).
 *   - success = true. Failed/transient attempts stay out of the
 *     user-facing surface; they're for admin debugging via the audit
 *     table itself.
 *
 * Cap at 50 rows, DESC by createdAt. Pagination can come later if any
 * single user accumulates more than 50 renewals (~4 years monthly,
 * ~50 years yearly — comfortably out of scope for v1).
 */

const MAX_ROWS = 50;

@Injectable()
export class TranzilaInvoicesService {
  private readonly logger = new Logger(TranzilaInvoicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string): Promise<InvoiceListItemDto[]> {
    const rows = await this.prisma.billingPaymentAttempt.findMany({
      where: {
        userId,
        kind: BillingPaymentAttemptKind.renewal,
        success: true,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    });
    this.logger.debug(`listForUser user=${userId} count=${rows.length}`);
    return rows.map((row) => this.toDto(row));
  }

  private toDto(row: BillingPaymentAttempt): InvoiceListItemDto {
    return {
      id: row.id,
      label: this.inferLabel(row.amount, row.currency),
      date: this.formatDate(row.createdAt),
      amount: this.formatAmount(row.amount, row.currency),
      /* pdfUrl null → InvoicesTable shows "—" in the actions column.
       * See class-level comment for the Phase 4.5 plan. */
      pdfUrl: null,
    };
  }

  /* Reverse-lookup the plan name from the amount, since
   * billing_payment_attempts doesn't store plan/cycle (the data lives
   * in user_metadata at charge time but we don't snapshot it on the
   * row). The amounts in BILLING_PLAN_AMOUNTS are unique per plan ×
   * cycle, so this is deterministic. Falls back to a generic label
   * if a plan price has changed and an old row no longer maps.
   *
   * Currency-aware in case we ever bill non-ILS, though today every
   * row is ILS. */
  private inferLabel(amountAgorot: number, currency: string): string {
    if (currency.toLowerCase() !== 'ils') {
      return 'חידוש מנוי';
    }
    const amountMajor = amountAgorot / 100;
    for (const [planId, cycles] of Object.entries(BILLING_PLAN_AMOUNTS)) {
      for (const [cycle, info] of Object.entries(cycles)) {
        if (info.amount === amountMajor) {
          return this.composePlanLabel(planId as PlanId, cycle as BillingCycle);
        }
      }
    }
    return 'חידוש מנוי';
  }

  private composePlanLabel(planId: PlanId, cycle: BillingCycle): string {
    const planName = planId.charAt(0).toUpperCase() + planId.slice(1);
    const cycleLabel = cycle === 'yearly' ? 'שנתי' : 'חודשי';
    return `חידוש ${planName} (${cycleLabel})`;
  }

  /* DD-MM-YYYY — matches the existing Stripe listInvoices format so
   * the InvoicesTable column renders identically across the migration. */
  private formatDate(value: Date): string {
    const dd = String(value.getDate()).padStart(2, '0');
    const mm = String(value.getMonth() + 1).padStart(2, '0');
    const yyyy = value.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }

  /* ₪129 / "12.50 USD" — same rule as the existing Stripe formatter.
   * Major units derived from minor (agorot); ILS shows whole shekels
   * (no minor unit display since real prices are whole), other
   * currencies get the standard `{major} {CODE}` form. */
  private formatAmount(amountMinor: number, currency: string): string {
    const major = amountMinor / 100;
    const code = (currency || 'ils').toLowerCase();
    if (code === 'ils') {
      const formatted = major.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
      return `₪${formatted}`;
    }
    return `${major.toFixed(2)} ${code.toUpperCase()}`;
  }
}
