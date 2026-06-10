import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../../config/config.service';
import { FetchBrandDto } from '../dto/fetch-brand.dto';

// Loose types for the upstream payload — context.dev owns the wire shape.
interface ContextDevColor {
  hex?: string;
  name?: string;
}

interface ContextDevLogo {
  url?: string;
  mode?: string;
  type?: string;
  resolution?: string;
  colors?: unknown[];
}

interface ContextDevBrand {
  title?: string;
  description?: string;
  slogan?: string;
  domain?: string;
  primary_language?: string;
  logos?: ContextDevLogo[];
  colors?: ContextDevColor[];
  socials?: unknown[];
  industries?: { eic?: unknown[] };
}

// Wizard draft shape — what the FE consumes.
export interface NormalizedBrand {
  name: string;
  description: string;
  slogan: string;
  logoUrl: string | null;
  logos: ContextDevLogo[];
  colors: Array<{ id: string; hex: string; name: string }>;
  socials: unknown[];
  industries: unknown[];
  primaryLanguage: string | null;
  domain: string | null;
}

const CONTEXT_DEV_URL = 'https://api.context.dev/v1/brand/retrieve';
const DEFAULT_LANGUAGE = 'hebrew';

// Proxies context.dev's /brand/retrieve and converts the response to
// the wizard draft shape. The API key never reaches the browser.
@Injectable()
export class BrandFetchService {
  private readonly logger = new Logger(BrandFetchService.name);

  constructor(private readonly config: AppConfigService) {}

  async fetch(dto: FetchBrandDto): Promise<NormalizedBrand> {
    // require() at call time, not in constructor — the app boots fine
    // without the key; only /brands/fetch fails if it's unset.
    const apiKey = this.config.require('CONTEXT_DEV_API_KEY');
    const domain = this.extractDomain(dto.url);

    const params = new URLSearchParams({ domain });
    const forceLanguage = dto.forceLanguage ?? DEFAULT_LANGUAGE;
    if (forceLanguage) params.set('force_language', forceLanguage);
    if (dto.maxSpeed) params.set('maxSpeed', 'true');

    let response: Response;
    try {
      response = await fetch(`${CONTEXT_DEV_URL}?${params.toString()}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      this.logger.error('context.dev request failed', err);
      throw new BadGatewayException('Brand lookup service is unreachable');
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // upstream returned non-JSON — fall through to error path
    }

    if (!response.ok) {
      const message = this.stringifyUpstreamError(body, response.status);
      throw new BadGatewayException(message);
    }

    const brand = (body as { brand?: ContextDevBrand })?.brand;
    if (!brand) {
      throw new BadGatewayException('Context.dev returned no brand data');
    }
    return this.normalize(brand);
  }

  // context.dev expects a bare hostname (no protocol, no path, no www.).
  // 400 with a useful message if the input doesn't parse as a URL.
  private extractDomain(input: string): string {
    const trimmed = input.trim();
    const candidate = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    let host: string;
    try {
      host = new URL(candidate).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      throw new BadRequestException('Domain looks invalid');
    }
    if (!host || !host.includes('.')) {
      throw new BadRequestException('Domain looks invalid');
    }
    return host;
  }

  // Map context.dev's brand object → our wizard draft shape.
  private normalize(brand: ContextDevBrand): NormalizedBrand {
    const logos = Array.isArray(brand.logos) ? brand.logos : [];
    const rawColors = Array.isArray(brand.colors) ? brand.colors : [];
    const socials = Array.isArray(brand.socials) ? brand.socials : [];
    const industries = Array.isArray(brand.industries?.eic)
      ? brand.industries.eic
      : [];

    // brand-level colors + per-logo colors, deduped by exact hex
    // (case-insensitive). context.dev splits the full set across
    // `brand.colors` and `logos[i].colors` for some brands, so we
    // walk both. Order is preserved (brand-level first, then logo-
    // extracted). We trust context.dev's ordering and don't try to
    // be smart beyond exact-hex dedup — earlier versions of this
    // code did perceptual-distance dedup and vibrancy reordering,
    // but the added complexity wasn't paying for itself; surface
    // any noise as a context.dev problem, not a us problem.
    const seen = new Set<string>();
    const colors: Array<{ id: string; hex: string; name: string }> = [];
    const pushColor = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const hex = (raw as ContextDevColor).hex;
      if (typeof hex !== 'string' || !hex.trim()) return;
      const key = hex.trim().toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      colors.push({
        id: randomUUID(),
        hex: hex.trim(),
        name: (raw as ContextDevColor).name ?? '',
      });
    };
    for (const c of rawColors) pushColor(c);
    for (const logo of logos) {
      if (!Array.isArray(logo.colors)) continue;
      for (const c of logo.colors) pushColor(c);
    }

    return {
      name: brand.title ?? '',
      description: brand.description ?? '',
      slogan: brand.slogan ?? '',
      logoUrl: this.pickDefaultLogo(logos)?.url ?? null,
      logos,
      colors,
      socials,
      industries,
      primaryLanguage: brand.primary_language ?? null,
      domain: brand.domain ?? null,
    };
  }

  // Prefer full-wordmark in light mode; fall back to any wordmark, then first.
  private pickDefaultLogo(logos: ContextDevLogo[]): ContextDevLogo | null {
    if (!logos.length) return null;
    const lightLogo = logos.find(
      (l) => l.type === 'logo' && l.mode === 'light',
    );
    if (lightLogo) return lightLogo;
    const anyLogo = logos.find((l) => l.type === 'logo');
    if (anyLogo) return anyLogo;
    return logos[0];
  }

  // context.dev's error envelope varies (plain message, Zod issues array,
  // or array under `message`). Coerce to a single string for the FE.
  private stringifyUpstreamError(body: unknown, status: number): string {
    const fallback = `Brand lookup failed (${status})`;
    if (!body || typeof body !== 'object') return fallback;

    const b = body as { message?: unknown; issues?: unknown };

    if (typeof b.message === 'string' && b.message.trim()) {
      return b.message;
    }

    const issues = Array.isArray(b.message)
      ? b.message
      : Array.isArray(b.issues)
        ? b.issues
        : null;
    if (issues?.length) {
      const summary = issues
        .map((i: { message?: unknown }) =>
          typeof i?.message === 'string' ? i.message : null,
        )
        .filter(Boolean)
        .join(', ');
      if (summary) return summary;
    }

    return fallback;
  }
}

