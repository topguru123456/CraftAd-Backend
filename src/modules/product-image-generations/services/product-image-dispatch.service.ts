import {
  BadGatewayException,
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
import { failGenerationRow } from '../../../common/generation-errors/fail-generation-row';
import { formatGenerationFailureLog } from '../../../common/generation-errors/generation-error.util';
import { ProductImagePromptService } from './product-image-prompt.service';

/** Wizard ratio → GCF aspect_ratio. `portrait` maps to '3:4' — the
 *  closest portrait ratio Imagen supports natively. See the matching
 *  comment in creative-generations/dispatch.service.ts. */
const RATIO_MAP: Record<string, string> = {
  square: '1:1',
  story: '9:16',
  portrait: '3:4',
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
  '3:4': '3:4',
};

const DISPATCHER_TIMEOUT_MS = 10_000;

export const VARIANTS_PER_DISPATCH = 3;

/** GCF wire shape — all four image slots must be fetchable HTTPS URLs. */
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

function ensureHttps(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

@Injectable()
export class ProductImageDispatchService {
  private readonly logger = new Logger(ProductImageDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly promptService: ProductImagePromptService,
    private readonly gcfImages: GcfImagePrepService,
  ) {}

  async dispatch(
    userId: string,
    userEmail: string,
    projectId: string,
  ): Promise<Array<Pick<CreativeGeneration, 'id' | 'projectId' | 'status'>>> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const brand = await this.prisma.brand.findFirst({
      where: { id: project.brandId, userId },
    });
    if (!brand) throw new NotFoundException('מותג לא נמצא');

    const { aspectRatio, productImgUrl, logoUrl } = this.resolveDispatchInputs(
      project,
      brand,
    );

    const prompt = this.promptService.build(
      ProductImagePromptService.fromProjectAndBrand(project, brand),
    );

    const settled = await Promise.allSettled(
      Array.from({ length: VARIANTS_PER_DISPATCH }, () =>
        this.dispatchOne(
          userId,
          userEmail,
          projectId,
          prompt,
          aspectRatio,
          productImgUrl,
          logoUrl,
        ),
      ),
    );

    const rows: Array<Pick<CreativeGeneration, 'id' | 'projectId' | 'status'>> = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') rows.push(result.value);
    }

    if (rows.length === 0) {
      const first = settled.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      throw new BadGatewayException(
        first?.reason instanceof Error
          ? first.reason.message
          : 'יצירת תמונות המוצר נכשלה — נסו שוב.',
      );
    }
    return rows;
  }

  private async dispatchOne(
    userId: string,
    userEmail: string,
    projectId: string,
    prompt: string,
    aspectRatio: string,
    productImgUrl: string,
    logoUrl: string,
  ): Promise<Pick<CreativeGeneration, 'id' | 'projectId' | 'status'>> {
    const apiSecret = this.config.require('API_SECRET');
    const webhookSecret = this.config.require('WEBHOOK_SECRET');
    const dispatcherUrl = this.config.require('GENERATE_DISPATCHER_URL');

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
      const fontReferenceUrl = ensureHttps(this.config.get('FONT_REFERENCE_URL'));
      if (!fontReferenceUrl) {
        throw new BadRequestException('FONT_REFERENCE_URL חסר בהגדרות השרת');
      }

      const rawImages = {
        logo: logoUrl || productImgUrl,
        product: productImgUrl,
        example: productImgUrl,
        font: fontReferenceUrl,
      };

      const preparedImages = await this.gcfImages.prepareSlots(userId, rawImages);

      const payload: DispatcherPayload = {
        uid: row.id,
        user_email: userEmail,
        webhook_url: this.buildWebhookUrl(webhookSecret),
        prompt,
        aspect_ratio: aspectRatio,
        images: preparedImages,
      };

      const result = await this.postToDispatcher(dispatcherUrl, apiSecret, payload);

      /* Non-OK initial response: GCF retries internally and the webhook
       * owns terminal state — same trust model as creative-generations'
       * DispatchService. The reaper (GenerationReaperService) ages out
       * rows that never settle, so we don't loading-spinner forever. */
      if (!result.ok) {
        this.logger.warn(
          formatGenerationFailureLog({
            uid: row.id,
            kind: 'generate',
            raw: `product-images dispatcher initial non-ok (relying on internal retry): ${result.error}`,
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
      const raw = err instanceof Error ? err.message : String(err);
      await failGenerationRow(this.prisma, row.id, raw, (line) =>
        this.logger.error(line),
      );
      return { id: row.id, projectId: row.projectId, status: GenerationStatus.failed };
    }
  }

  private resolveDispatchInputs(
    project: Project,
    brand: Brand,
  ): {
    aspectRatio: string;
    productImgUrl: string;
    logoUrl: string;
  } {
    if (!project.aspectRatio) {
      throw new BadRequestException('לפרויקט חסר aspect_ratio');
    }
    const aspectRatio = RATIO_MAP[project.aspectRatio];
    if (!aspectRatio) {
      throw new BadRequestException(
        `ratio '${project.aspectRatio}' is not supported`,
      );
    }
    const productImgUrl = ensureHttps(
      (project.draft as { images?: Array<{ url?: string }> })?.images?.[0]?.url,
    );
    if (!productImgUrl) {
      throw new BadRequestException('לפרויקט חסרה תמונת מוצר');
    }

    const logoUrl = ensureHttps(brand.logoUrl); // optional — GCF falls back to product slot

    return { aspectRatio, productImgUrl, logoUrl };
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
        /* non-JSON — keep the status-only fallback */
      }
      this.logger.warn(`product-images dispatcher non-ok: ${detail}`);
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
