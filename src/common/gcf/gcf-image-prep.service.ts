import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import sharp from 'sharp';
import { AppConfigService } from '../../config/config.service';
import { SupabaseStorageService } from '../storage/supabase-storage.service';

const RASTER_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MIN_IMAGE_BYTES = 200;
const FETCH_TIMEOUT_MS = 15_000;

export type GcfImageSlot = 'logo' | 'product' | 'example' | 'font';

const SLOT_LABEL_HE: Record<GcfImageSlot, string> = {
  logo: 'לוגו המותג',
  product: 'תמונת המוצר',
  example: 'מודעת הייחוס',
  font: 'ייחוס גופן',
};

@Injectable()
export class GcfImagePrepService {
  private readonly logger = new Logger(GcfImagePrepService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storage: SupabaseStorageService,
  ) {}

  /** Ensure every GCF slot is a fetchable raster on our Supabase CDN.
   *
   * The `product` slot is uniquely allowed to be empty: when the user
   * didn't upload a product image, the GCF dispatcher itself auto-
   * generates one server-side, so we pass `""` through and let the
   * dispatcher handle it. All other slots (logo, example, font) are
   * still required — those are always known up-front (brand asset,
   * template-pool fallback, config). */
  async prepareSlots(
    userId: string,
    slots: Record<GcfImageSlot, string>,
  ): Promise<Record<GcfImageSlot, string>> {
    const out = { ...slots };
    const bucketBySlot: Record<GcfImageSlot, string> = {
      logo: 'brand-assets',
      product: 'campaign-uploads',
      example: 'campaign-uploads',
      font: 'campaign-uploads',
    };

    for (const slot of Object.keys(slots) as GcfImageSlot[]) {
      const url = slots[slot];
      if (!url?.trim()) {
        if (slot === 'product') {
          out[slot] = '';
          continue;
        }
        throw new BadRequestException(`חסרה תמונה: ${SLOT_LABEL_HE[slot]}`);
      }
      try {
        out[slot] = await this.prepareOne(url, {
          userId,
          bucket: bucketBySlot[slot],
          prefix: slot,
          labelHe: SLOT_LABEL_HE[slot],
        });
      } catch (err) {
        /* The `example` slot is a STYLE anchor pulled from a 369-entry
         * random pool — a flaky AVIF URL or a transient Supabase timeout
         * shouldn't kill the variant. Degrade to the prepared logo
         * (pre-pool fallback behavior) instead of rethrowing. Other
         * slots stay required. The iteration order in the calling
         * payload is logo → product → example → font, so out.logo is
         * already populated when we hit this branch. */
        if (slot === 'example') {
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `example slot prep failed, falling back to logo: ${detail}`,
          );
          out[slot] = out.logo;
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  private async prepareOne(
    url: string,
    opts: {
      userId: string;
      bucket: string;
      prefix: string;
      labelHe: string;
    },
  ): Promise<string> {
    const supabaseHost = new URL(this.config.require('SUPABASE_URL')).host;
    const parsed = new URL(url);
    const inOurBucket =
      parsed.host === supabaseHost &&
      this.storage.extractPath(url, opts.bucket) != null;

    if (inOurBucket) {
      await this.assertFetchableRaster(url, opts.labelHe);
      return url;
    }

    const { bytes, contentType } = await this.fetchRemote(url, opts.labelHe);
    const png = await this.toPng(bytes, contentType, opts.labelHe);
    const path = `${opts.userId}/gcf-${opts.prefix}-${Date.now()}.png`;
    const uploaded = await this.storage.upload(
      opts.bucket,
      path,
      png,
      'image/png',
    );
    this.logger.debug(
      `mirrored ${opts.prefix} → ${opts.bucket}/${path}`,
    );
    return uploaded.publicUrl;
  }

  private async assertFetchableRaster(url: string, labelHe: string): Promise<void> {
    const { bytes, contentType } = await this.fetchRemote(url, labelHe);
    if (!RASTER_MIMES.has(contentType) && !contentType.includes('svg')) {
      throw new BadRequestException(
        `${labelHe}: פורמט לא נתמך (${contentType})`,
      );
    }
    if (bytes.length < MIN_IMAGE_BYTES) {
      throw new BadRequestException(`${labelHe}: קובץ התמונה ריק או פגום`);
    }
  }

  private async fetchRemote(
    url: string,
    labelHe: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'image/*' },
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new BadRequestException(
          `${labelHe}: לא ניתן להוריד את התמונה (${response.status})`,
        );
      }
      const rawType =
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
        'application/octet-stream';
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.length < MIN_IMAGE_BYTES) {
        throw new BadRequestException(`${labelHe}: קובץ התמונה ריק או פגום`);
      }
      return { bytes, contentType: rawType };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const detail =
        err instanceof Error && err.name === 'AbortError'
          ? 'timeout'
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`fetch ${labelHe} failed: ${detail} url=${url}`);
      throw new BadRequestException(
        `${labelHe}: לא ניתן להוריד את התמונה — העלו קובץ PNG/JPG`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async toPng(
    bytes: Uint8Array,
    contentType: string,
    labelHe: string,
  ): Promise<Uint8Array> {
    try {
      return await sharp(Buffer.from(bytes))
        .png()
        .toBuffer()
        .then((b) => new Uint8Array(b));
    } catch (err) {
      this.logger.warn(
        `rasterize ${labelHe} failed (${contentType}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new BadRequestException(
        `${labelHe}: פורמט לא נתמך — העלו PNG או JPG`,
      );
    }
  }
}
