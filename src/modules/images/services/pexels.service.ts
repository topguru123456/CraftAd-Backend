import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { AppConfigService } from '../../../config/config.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';
import { PexelsImportDto } from '../dto/pexels-import.dto';
import { PexelsSearchDto } from '../dto/pexels-search.dto';

const BUCKET = 'campaign-uploads';
const SEARCH_URL = 'https://api.pexels.com/v1/search';
const PER_PAGE_DEFAULT = 24;

// Pexels CDN hostnames we accept for import. Deliberately narrow — any
// other host means somebody is trying to use this endpoint as a generic
// URL-to-Storage proxy (exfiltration / quota burning).
const ALLOWED_HOSTS = new Set(['images.pexels.com', 'www.pexels.com', 'pexels.com']);

interface PexelsPhoto {
  id: number;
  photographer: string;
  alt: string;
  src: {
    original: string | null;
    large: string | null;
    medium: string | null;
    small: string | null;
  };
}

export interface PexelsSearchResult {
  page: number;
  perPage: number;
  totalResults: number;
  nextPage: string | null;
  photos: PexelsPhoto[];
}

export interface PexelsImportResult {
  url: string;
  path: string;
}

// Two operations against the Pexels API:
//   search — paginated search, response shaped to just what the picker needs
//   import — fetch CDN bytes server-side, upload to campaign-uploads/<userId>/
//
// The Pexels API key never reaches the browser. Hostname allowlist on
// import keeps this from being abused as an open URL-fetcher.
@Injectable()
export class PexelsService {
  private readonly logger = new Logger(PexelsService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async search(dto: PexelsSearchDto): Promise<PexelsSearchResult> {
    const apiKey = this.config.require('PEXELS_API_KEY');
    const query = dto.query.trim();
    const page = dto.page ?? 1;
    const perPage = dto.perPage ?? PER_PAGE_DEFAULT;

    const params = new URLSearchParams({
      query,
      page: String(page),
      per_page: String(perPage),
    });

    let response: Response;
    let body: unknown = null;
    try {
      response = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: apiKey, // Pexels uses raw key (no Bearer prefix)
          Accept: 'application/json',
        },
      });
      body = await response.json();
    } catch (err) {
      this.logger.error('Pexels search request failed', err);
      throw new BadGatewayException('Pexels search service is unreachable');
    }

    if (!response.ok) {
      const message =
        (body as { error?: string; message?: string })?.error ??
        (body as { message?: string })?.message ??
        `Pexels request failed (${response.status})`;
      throw new BadGatewayException(message);
    }

    return this.shapeSearchResponse(body, page, perPage);
  }

  async import(userId: string, dto: PexelsImportDto): Promise<PexelsImportResult> {
    const apiKey = this.config.require('PEXELS_API_KEY');

    const parsed = new URL(dto.url);
    if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new BadRequestException('url must be a Pexels CDN host');
    }

    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        headers: {
          Authorization: apiKey,
          Accept: 'image/*',
        },
      });
    } catch (err) {
      this.logger.error('Pexels image fetch failed', err);
      throw new BadGatewayException('Failed to fetch Pexels image');
    }

    if (!response.ok) {
      throw new BadGatewayException(`Failed to fetch Pexels image (${response.status})`);
    }

    const contentType = response.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      throw new BadGatewayException('Pexels response is not an image');
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const ext = dto.ext ? dto.ext.toLowerCase() : extFromMime(contentType);
    const photoId =
      typeof dto.id === 'number' && Number.isFinite(dto.id) ? dto.id : 'unknown';
    const path = `${userId}/pexels-${photoId}-${Date.now()}.${ext}`;

    const uploaded = await this.storage.upload(BUCKET, path, bytes, contentType);
    return { url: uploaded.publicUrl, path: uploaded.path };
  }

  // Upstream returns ~25 fields per photo; we keep id, photographer,
  // alt, and a handful of src variants. The picker renders src.medium.
  private shapeSearchResponse(
    body: unknown,
    fallbackPage: number,
    fallbackPerPage: number,
  ): PexelsSearchResult {
    const photos = Array.isArray((body as { photos?: unknown[] }).photos)
      ? (body as { photos: Array<Record<string, unknown>> }).photos.map((p) => ({
          id: Number(p.id),
          photographer: typeof p.photographer === 'string' ? p.photographer : '',
          alt: typeof p.alt === 'string' ? p.alt : '',
          src: {
            original: (p.src as { original?: string })?.original ?? null,
            large: (p.src as { large?: string })?.large ?? null,
            medium: (p.src as { medium?: string })?.medium ?? null,
            small: (p.src as { small?: string })?.small ?? null,
          },
        }))
      : [];

    return {
      page: (body as { page?: number }).page ?? fallbackPage,
      perPage: (body as { per_page?: number }).per_page ?? fallbackPerPage,
      totalResults: (body as { total_results?: number }).total_results ?? 0,
      nextPage: (body as { next_page?: string | null }).next_page ?? null,
      photos,
    };
  }
}

// Pexels CDN URLs sometimes carry query params (?auto=compress&...) — don't
// trust the URL path's extension; derive from the response Content-Type.
function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}
