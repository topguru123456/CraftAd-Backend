import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Brand,
  CreativeGeneration,
  GenerationStatus,
  Project,
} from '@prisma/client';
import { GcfImagePrepService } from '../../../common/gcf/gcf-image-prep.service';
import { AppConfigService } from '../../../config/config.service';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolveCampaignGcfImageSlots } from '../lib/resolve-campaign-gcf-images';
import { ensureHttps } from '../lib/gcf-url';
import { failGenerationRow } from '../../../common/generation-errors/fail-generation-row';
import { formatGenerationFailureLog } from '../../../common/generation-errors/generation-error.util';
import { PromptAssemblerService } from './prompt-assembler.service';

const RATIO_MAP: Record<string, string> = {
  square: '1:1',
  story: '9:16',
  // `portrait` was historically labeled 4:5 in the wizard, but Imagen's
  // accepted set is {1:1, 9:16, 16:9, 3:4, 4:3}, so we send the closest
  // native value (3:4). The wizard config now also reflects '3:4' so
  // there's no longer a label/wire-value mismatch.
  portrait: '3:4',
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
  '3:4': '3:4',
};

const DISPATCHER_TIMEOUT_MS = 10_000;

interface DispatcherPayload {
  uid: string;
  user_email: string;
  webhook_url: string;
  prompt: string;
  aspect_ratio: string;
  images: {
    logo: string;
    product: string;
    example: string;
    font: string;
  };
}

interface ResolvedInputs {
  aspectRatio: string;
  logoUrl: string;
  primaryColor: string;
  secondaryJoined: string;
  gcfImages: ReturnType<typeof resolveCampaignGcfImageSlots>;
}

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly promptAssembler: PromptAssemblerService,
    private readonly gcfImages: GcfImagePrepService,
  ) {}

  async dispatch(
    userId: string,
    userEmail: string,
    projectId: string,
  ): Promise<Pick<CreativeGeneration, 'id' | 'projectId' | 'status'>> {
    const apiSecret = this.config.require('API_SECRET');
    const webhookSecret = this.config.require('WEBHOOK_SECRET');
    const dispatcherUrl = this.config.require('GENERATE_DISPATCHER_URL');

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const brand = await this.prisma.brand.findFirst({
      where: { id: project.brandId, userId },
    });
    if (!brand) throw new NotFoundException('מותג לא נמצא');

    const inputs = this.resolveDispatchInputs(project, brand);

    const prompt = this.promptAssembler.assemble({
      brand: {
        websiteUrl: brand.websiteUrl ?? '',
        description: brand.description ?? '',
        primaryColor: inputs.primaryColor,
        secondaryColorsJoined: inputs.secondaryJoined,
      },
      project: this.draftToPromptInput(project.draft),
      referenceMode: inputs.gcfImages.referenceMode,
      /* Mirrors what we send the GCF as `aspect_ratio`. The dispatcher
       * payload is the primary channel; passing the same value into
       * the prompt is the textual backstop so the model has the
       * constraint both as an API parameter AND in its instructions. */
      aspectRatio: inputs.aspectRatio,
    });

    const row = await this.prisma.creativeGeneration.create({
      data: {
        projectId,
        userId,
        status: GenerationStatus.pending,
        prompt,
      },
      select: { id: true, projectId: true, status: true },
    });

    try {
      const preparedImages = await this.gcfImages.prepareSlots(userId, {
        logo: inputs.gcfImages.logo,
        product: inputs.gcfImages.product,
        example: inputs.gcfImages.example,
        font: inputs.gcfImages.font,
      });

      const payload: DispatcherPayload = {
        uid: row.id,
        user_email: userEmail,
        webhook_url: this.buildWebhookUrl(webhookSecret),
        prompt,
        aspect_ratio: inputs.aspectRatio,
        images: preparedImages,
      };

      const result = await this.postToDispatcher(dispatcherUrl, apiSecret, payload);

      /* Non-OK initial response: the GCF dispatcher retries internally
       * (5xx / network / timeout / queue back-pressure) and we own the
       * webhook that settles the row to ready / failed. Marking the
       * row failed here would surface a premature toast for a request
       * the dispatcher is still working on; instead we leave it in
       * `dispatched` and trust the eventual webhook. The reaper
       * (GenerationReaperService) ages out rows that never settle, so
       * a truly stuck dispatch can't loading-spinner forever. */
      if (!result.ok) {
        this.logger.warn(
          formatGenerationFailureLog({
            uid: row.id,
            kind: 'generate',
            raw: `dispatcher initial non-ok (relying on internal retry): ${result.error}`,
            userMessage: '(no user message — row stays dispatched)',
          }),
        );
      }

      return this.prisma.creativeGeneration.update({
        where: { id: row.id },
        data: { status: GenerationStatus.dispatched },
        select: { id: true, projectId: true, status: true },
      });
    } catch (err) {
      /* Caught here only for OUR-side failures — image prep, payload
       * build, or anything that throws before postToDispatcher even
       * returns. The dispatcher never saw the request in those cases,
       * so its internal retry can't recover us. Mark failed + rethrow
       * so the FE shows the actual error. */
      const raw = err instanceof Error ? err.message : String(err);
      await failGenerationRow(this.prisma, row.id, raw, (line) =>
        this.logger.error(line),
      );
      throw err;
    }
  }

  private resolveDispatchInputs(project: Project, brand: Brand): ResolvedInputs {
    if (!project.aspectRatio) {
      throw new BadRequestException('לפרויקט חסר aspect_ratio');
    }
    const aspectRatio = RATIO_MAP[project.aspectRatio];
    if (!aspectRatio) {
      throw new BadRequestException(
        `ratio '${project.aspectRatio}' is not supported`,
      );
    }

    const logoUrl = ensureHttps(brand.logoUrl);
    if (!logoUrl) {
      throw new BadRequestException('למותג חסר לוגו — לא ניתן להפעיל יצירה');
    }

    const colors = Array.isArray(brand.colors)
      ? (brand.colors as Array<{ hex?: string }>)
      : [];
    if (!colors.length || !colors[0]?.hex) {
      throw new BadRequestException('למותג חסרים צבעים — לא ניתן להפעיל יצירה');
    }

    const fontReferenceUrl = ensureHttps(this.config.get('FONT_REFERENCE_URL'));
    if (!fontReferenceUrl) {
      throw new BadRequestException(
        'FONT_REFERENCE_URL חסר בהגדרות השרת',
      );
    }

    const gcfImages = resolveCampaignGcfImageSlots({
      logoUrl,
      draft: project.draft,
      fontReferenceUrl,
    });

    if (!gcfImages.product) {
      throw new BadRequestException('לפרויקט חסרה תמונת מוצר');
    }
    if (!gcfImages.example) {
      throw new BadRequestException('למותג חסר לוגו — לא ניתן להפעיל יצירה');
    }
    if (gcfImages.example === gcfImages.product) {
      throw new BadRequestException('תמונת הייחוס לא יכולה להיות זהה לתמונת המוצר');
    }

    if (gcfImages.referenceMode === 'fallback') {
      this.logger.debug(
        `project ${project.id}: no optional reference ad — pipeline example slot uses logo duplicate`,
      );
    }

    return {
      aspectRatio,
      logoUrl,
      primaryColor: colors[0].hex!,
      secondaryJoined: colors
        .slice(1)
        .map((c) => c?.hex)
        .filter((hex): hex is string => Boolean(hex))
        .join(', '),
      gcfImages,
    };
  }

  private draftToPromptInput(draft: unknown) {
    const ctx = (draft as { context?: Record<string, string> })?.context ?? {};
    return {
      productName: ctx.product_name ?? '',
      description: ctx.description ?? '',
      natureHe: ctx.nature_he ?? '',
      locationHe: ctx.location_he ?? '',
      purposeHe: ctx.purpose_he ?? '',
      audienceDisplay: ctx.audience_display ?? '',
      platform: ctx.platform ?? '',
      landingPageUrl: ctx.landing_page_url ?? '',
    };
  }

  private buildWebhookUrl(secret: string): string {
    const base = this.config.require('BACKEND_PUBLIC_URL');
    return `${base}/webhooks/creative?token=${encodeURIComponent(secret)}`;
  }

  private async postToDispatcher(
    url: string,
    apiSecret: string,
    payload: DispatcherPayload,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISPATCHER_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiSecret}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) return { ok: true };

      let detail = `Dispatcher returned ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body?.message === 'string') detail = body.message;
        else if (typeof body?.error === 'string') detail = body.error;
      } catch {
        /* keep status-only detail */
      }
      this.logger.warn(`dispatcher non-ok: ${detail}`);
      return { ok: false, error: detail };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const detail = isAbort
        ? `Dispatcher timed out after ${DISPATCHER_TIMEOUT_MS / 1000}s`
        : `Dispatcher request failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
      this.logger.error(detail);
      return { ok: false, error: detail };
    } finally {
      clearTimeout(timeout);
    }
  }
}
