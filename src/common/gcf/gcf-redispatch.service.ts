import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Brand, EditStatus, GenerationStatus, Project } from '@prisma/client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GcfImagePrepService } from './gcf-image-prep.service';
import { AppConfigService } from '../../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../storage/supabase-storage.service';
import { resolveCampaignGcfImageSlots } from '../../modules/creative-generations/lib/resolve-campaign-gcf-images';
import { ensureHttps } from '../../modules/creative-generations/lib/gcf-url';

const RATIO_MAP: Record<string, string> = {
  square: '1:1',
  story: '9:16',
  portrait: '1:1',
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
};

const DISPATCHER_TIMEOUT_MS = 10_000;
const EDIT_SOURCE_SIGNED_URL_TTL_SEC = 600;
const CREATIVES_CLEAN_BUCKET = 'creatives-clean';

interface GeneratePayload {
  uid: string;
  user_email: string;
  webhook_url: string;
  prompt: string;
  aspect_ratio: string;
  images: { logo: string; product: string; example: string; font: string };
}

interface EditPayload {
  uid: string;
  webhook_url: string;
  prompt: string;
  source_image: string;
  aspect_ratio: string;
}

@Injectable()
export class GcfRedispatchService {
  private readonly logger = new Logger(GcfRedispatchService.name);
  private supabaseAdmin: SupabaseClient | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly gcfImages: GcfImagePrepService,
    private readonly storage: SupabaseStorageService,
  ) {}

  /** Re-post an existing generation row to the generate dispatcher (same prompt/images). */
  async redispatchGeneration(generationId: string): Promise<{ ok: boolean; error?: string }> {
    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: generationId },
      include: { project: true },
    });
    if (!row?.project) throw new NotFoundException('Generation not found');
    if (!row.prompt?.trim()) {
      return { ok: false, error: 'Missing stored prompt for redispatch' };
    }

    const brand = await this.prisma.brand.findFirst({
      where: { id: row.project.brandId, userId: row.userId },
    });
    if (!brand) return { ok: false, error: 'Brand not found for redispatch' };

    const userEmail = await this.resolveUserEmail(row.userId);
    const aspectRatio = this.resolveAspectRatio(row.project);
    const rawImages = this.resolveGenerateImageSlots(row.project, brand);
    const preparedImages = await this.gcfImages.prepareSlots(row.userId, rawImages);

    const payload: GeneratePayload = {
      uid: row.id,
      user_email: userEmail,
      webhook_url: this.buildGenerateWebhookUrl(),
      prompt: row.prompt,
      aspect_ratio: aspectRatio,
      images: preparedImages,
    };

    return this.postGenerate(payload);
  }

  /** Re-post an in-flight edit to the edit dispatcher. */
  async redispatchEdit(generationId: string): Promise<{ ok: boolean; error?: string }> {
    const row = await this.prisma.creativeGeneration.findUnique({
      where: { id: generationId },
      include: { project: true },
    });
    if (!row?.project) throw new NotFoundException('Generation not found');
    if (!row.editPrompt?.trim()) {
      return { ok: false, error: 'Missing edit prompt for redispatch' };
    }

    const aspectRatio = this.resolveAspectRatio(row.project);
    const sourceImage = await this.resolveEditSourceUrl(row);

    const payload: EditPayload = {
      uid: row.id,
      webhook_url: this.buildEditWebhookUrl(),
      prompt: row.editPrompt,
      source_image: sourceImage,
      aspect_ratio: aspectRatio,
    };

    return this.postEdit(payload);
  }

  private resolveGenerateImageSlots(
    project: Project,
    brand: Brand,
  ): { logo: string; product: string; example: string; font: string } {
    const serviceType = project.serviceType ?? '';

    if (serviceType === 'product-images') {
      const productImgUrl = ensureHttps(
        (project.draft as { images?: Array<{ url?: string }> })?.images?.[0]?.url,
      );
      if (!productImgUrl) {
        throw new BadRequestException('לפרויקט חסרה תמונת מוצר');
      }
      const logoUrl = ensureHttps(brand.logoUrl) || productImgUrl;
      const fontReferenceUrl = ensureHttps(this.config.get('FONT_REFERENCE_URL'));
      if (!fontReferenceUrl) {
        throw new BadRequestException('FONT_REFERENCE_URL חסר בהגדרות השרת');
      }
      return {
        logo: logoUrl,
        product: productImgUrl,
        example: productImgUrl,
        font: fontReferenceUrl,
      };
    }

    const fontReferenceUrl = ensureHttps(this.config.get('FONT_REFERENCE_URL'));
    if (!fontReferenceUrl) {
      throw new BadRequestException('FONT_REFERENCE_URL חסר בהגדרות השרת');
    }
    const slots = resolveCampaignGcfImageSlots({
      logoUrl: brand.logoUrl ?? '',
      draft: project.draft,
      fontReferenceUrl,
    });
    return {
      logo: slots.logo,
      product: slots.product,
      example: slots.example,
      font: slots.font,
    };
  }

  private resolveAspectRatio(project: Project): string {
    if (!project.aspectRatio) {
      throw new BadRequestException('לפרויקט חסר aspect_ratio');
    }
    const mapped = RATIO_MAP[project.aspectRatio];
    if (!mapped) {
      throw new BadRequestException(`ratio '${project.aspectRatio}' is not supported`);
    }
    return mapped;
  }

  private async resolveEditSourceUrl(row: {
    userId: string;
    id: string;
    cleanImageUrl: string | null;
    imageUrl: string | null;
  }): Promise<string> {
    const cleanPath = row.cleanImageUrl?.trim();
    if (cleanPath) {
      const signed = await this.storage.createSignedUrl(
        CREATIVES_CLEAN_BUCKET,
        cleanPath,
        EDIT_SOURCE_SIGNED_URL_TTL_SEC,
      );
      if (signed) return signed;
    }
    const publicUrl = row.imageUrl?.trim();
    if (publicUrl) return publicUrl;
    throw new BadRequestException('No source image for edit redispatch');
  }

  private async resolveUserEmail(userId: string): Promise<string> {
    const { data, error } = await this.adminClient().auth.admin.getUserById(userId);
    if (error || !data.user?.email) {
      this.logger.warn(`Could not resolve email for user ${userId}: ${error?.message ?? 'no email'}`);
      return '';
    }
    return data.user.email;
  }

  private adminClient(): SupabaseClient {
    if (this.supabaseAdmin) return this.supabaseAdmin;
    this.supabaseAdmin = createClient(
      this.config.require('SUPABASE_URL'),
      this.config.require('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    return this.supabaseAdmin;
  }

  private buildGenerateWebhookUrl(): string {
    const base = this.config.require('BACKEND_PUBLIC_URL');
    const secret = this.config.require('WEBHOOK_SECRET');
    return `${base}/webhooks/creative?token=${encodeURIComponent(secret)}`;
  }

  private buildEditWebhookUrl(): string {
    const base = this.config.require('BACKEND_PUBLIC_URL');
    const secret = this.config.require('WEBHOOK_SECRET');
    return `${base}/webhooks/creative-edit?token=${encodeURIComponent(secret)}`;
  }

  private async postGenerate(
    payload: GeneratePayload,
  ): Promise<{ ok: boolean; error?: string }> {
    const url = this.config.require('GENERATE_DISPATCHER_URL');
    const apiSecret = this.config.require('API_SECRET');
    return this.postJson(url, apiSecret, payload);
  }

  private async postEdit(payload: EditPayload): Promise<{ ok: boolean; error?: string }> {
    const url = this.config.require('EDIT_DISPATCHER_URL');
    const apiSecret = this.config.require('API_SECRET');
    return this.postJson(url, apiSecret, payload);
  }

  private async postJson(
    url: string,
    apiSecret: string,
    body: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
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
        body: JSON.stringify(body),
      });
      if (response.ok) return { ok: true };
      let detail = `Dispatcher returned ${response.status}`;
      try {
        const parsed = await response.json();
        if (typeof parsed?.message === 'string') detail = parsed.message;
        else if (typeof parsed?.error === 'string') detail = parsed.error;
      } catch {
        /* non-JSON */
      }
      return { ok: false, error: detail };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const detail = isAbort
        ? `Dispatcher timed out after ${DISPATCHER_TIMEOUT_MS / 1000}s`
        : `Dispatcher request failed: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, error: detail };
    } finally {
      clearTimeout(timeout);
    }
  }
}
