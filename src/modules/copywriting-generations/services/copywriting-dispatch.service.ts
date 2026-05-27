import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Brand,
  CopywritingGeneration,
  GenerationStatus,
  Project,
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  COPYWRITING_FRAMEWORKS,
  CopywritingFramework,
  CopywritingPromptInput,
  CopywritingPromptService,
} from './copywriting-prompt.service';
import {
  OpenAiCopywritingService,
  OpenAiResult,
} from './openai-copywriting.service';

// Number of variants fanned out per dispatch click. Matches campaign-
// creative's pattern so the two flows behave identically from a "click
// → see 3 results" perspective. Capped at 5 (the framework list size)
// to keep variant strategies non-repeating within a dispatch.
export const VARIANTS_PER_DISPATCH = 3;

// Orchestrates a copywriting dispatch end-to-end:
//   1. Load project + brand (both scoped to caller; 404 if not theirs).
//   2. Pull the resolved-Hebrew context the FE wrote into project.draft.
//   3. Create N pending rows in one batch — reserves uids the response
//      can hand back, lets the FE optimistically render placeholders.
//   4. For each (row, framework) pair: assemble prompt → call GPT-4o →
//      update row. Runs in parallel via Promise.allSettled so one bad
//      variant can't kill the others.
//   5. Return every row (ready + failed). The controller exposes them
//      verbatim; the FE renders failed rows as a "couldn't generate"
//      card so the user knows what happened without us hiding state.
//
// Why synchronous (vs Cloud Tasks like images):
//   GPT-4o text completions land in 5–15s per call; 3 in parallel is
//   still ~15s wall-clock. Cloud Run can handle that comfortably in a
//   single request. Splitting into dispatcher → worker → webhook would
//   add latency, infra, and failure modes for zero UX gain on text.
@Injectable()
export class CopywritingDispatchService {
  private readonly logger = new Logger(CopywritingDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: CopywritingPromptService,
    private readonly openai: OpenAiCopywritingService,
  ) {}

  async dispatch(
    userId: string,
    projectId: string,
  ): Promise<CopywritingGeneration[]> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const brand = await this.prisma.brand.findFirst({
      where: { id: project.brandId, userId },
    });
    if (!brand) throw new NotFoundException('מותג לא נמצא');

    const promptInput = this.draftToPromptInput(brand, project);
    const frameworks = this.pickFrameworks(VARIANTS_PER_DISPATCH);

    // Phase 1: reserve uids. Done in a transaction so we never get
    // "2 of 3 rows created" — either all pending rows exist or none.
    const reservedRows = await this.prisma.$transaction(
      frameworks.map((f) =>
        this.prisma.copywritingGeneration.create({
          data: {
            projectId,
            userId,
            status: GenerationStatus.pending,
            framework: f.id,
            frameworkHe: f.he,
          },
        }),
      ),
    );

    // Phase 2: call OpenAI for each row in parallel. allSettled so a
    // single timeout/refusal doesn't take down its siblings.
    const settled = await Promise.allSettled(
      reservedRows.map((row, idx) =>
        this.generateAndPersist(row.id, frameworks[idx], promptInput),
      ),
    );

    // Log a one-line summary for ops without dumping per-row noise on
    // the happy path. Per-row failures are already logged inside
    // generateAndPersist with their reason.
    const succeeded = settled.filter((r) => r.status === 'fulfilled').length;
    if (succeeded < settled.length) {
      this.logger.warn(
        `Dispatch ${projectId}: ${succeeded}/${settled.length} variants succeeded`,
      );
    }

    // Re-read the rows so the response carries final status + the
    // payload that landed (or the errorMessage if failed). One query
    // for all N is cheaper than N point reads.
    return this.prisma.copywritingGeneration.findMany({
      where: { id: { in: reservedRows.map((r) => r.id) } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // One variant's full lifecycle: build prompt → call OpenAI → write
  // result (ready or failed) atomically. Never throws — wraps every
  // failure into a failed-row update so the parent allSettled doesn't
  // need to distinguish thrown vs returned errors.
  private async generateAndPersist(
    rowId: string,
    framework: CopywritingFramework,
    base: Omit<CopywritingPromptInput, 'framework'>,
  ): Promise<void> {
    let result: OpenAiResult;
    try {
      const { system, user } = this.promptService.build({ ...base, framework });
      result = await this.openai.generate(system, user);
    } catch (err) {
      this.logger.error(
        `Variant ${rowId} (${framework.id}) crashed: ${err instanceof Error ? err.message : err}`,
      );
      result = { ok: false, reason: 'internal_error' };
    }

    if (!result.ok) {
      this.logger.warn(`Variant ${rowId} (${framework.id}) failed: ${result.reason}`);
      await this.prisma.copywritingGeneration.update({
        where: { id: rowId },
        data: {
          status: GenerationStatus.failed,
          errorMessage: result.reason.slice(0, 1000),
        },
      });
      return;
    }

    await this.prisma.copywritingGeneration.update({
      where: { id: rowId },
      data: {
        status: GenerationStatus.ready,
        adText: result.output.adText,
        tonesUsed: result.output.tonesUsed,
        keywords: result.output.keywords,
        conversionScore: result.output.conversionScore,
      },
    });
  }

  // Pull `count` frameworks from the catalog with a random start offset
  // so the user sees a different rotation on repeat clicks. We don't
  // repeat within a dispatch (count <= catalog size) so "variant
  // diversity" is guaranteed.
  private pickFrameworks(count: number): CopywritingFramework[] {
    if (count > COPYWRITING_FRAMEWORKS.length) {
      throw new BadRequestException(
        `Asked for ${count} variants but only ${COPYWRITING_FRAMEWORKS.length} frameworks exist`,
      );
    }
    const start = Math.floor(Math.random() * COPYWRITING_FRAMEWORKS.length);
    return Array.from({ length: count }, (_, i) =>
      COPYWRITING_FRAMEWORKS[(start + i) % COPYWRITING_FRAMEWORKS.length],
    );
  }

  // Maps the FE-built draft.context (resolved Hebrew labels) plus the
  // copywriting-specific fields the wizard collects onto the prompt
  // builder's input shape. The FE is the only place that knows about
  // wizard taxonomies — server stays decoupled.
  private draftToPromptInput(
    brand: Brand,
    project: Project,
  ): Omit<CopywritingPromptInput, 'framework'> {
    const draft = (project.draft ?? {}) as {
      context?: Record<string, unknown>;
      topics?: unknown;
      marketingPromise?: unknown;
      marketingOffer?: unknown;
      callToAction?: unknown;
    };
    const ctx = (draft.context ?? {}) as Record<string, unknown>;
    const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
    const topicsRaw = Array.isArray(draft.topics) ? draft.topics : [];
    const topics = topicsRaw
      .map((t): string => (typeof t === 'string' ? t.trim() : ''))
      .filter((t) => t.length > 0);

    return {
      brand: {
        name: brand.name ?? '',
        description: brand.description ?? '',
        websiteUrl: brand.websiteUrl ?? '',
        tone: brand.tone ?? null,
      },
      project: {
        productName:      asStr(ctx.product_name),
        saleType:         asStr(ctx.sale_type),
        audienceType:     asStr(ctx.audience_type),
        natureHe:         asStr(ctx.nature_he),
        locationHe:       asStr(ctx.location_he),
        purposeHe:        asStr(ctx.purpose_he),
        audienceDisplay:  asStr(ctx.audience_display),
        platform:         asStr(ctx.platform),
        primaryTone:      asStr(ctx.primary_tone),
        brief:            asStr(ctx.brief),
        topics,
        marketingPromise: asStr(draft.marketingPromise),
        marketingOffer:   asStr(draft.marketingOffer),
        callToAction:     asStr(draft.callToAction),
      },
    };
  }
}
