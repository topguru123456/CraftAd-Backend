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

    // Two-pass color extraction:
    //
    //   1. Collect every unique-hex candidate from `brand.colors` plus
    //      each `logos[i].colors`. context.dev splits the full set
    //      across those arrays for some brands, so merging surfaces
    //      everything the API actually returned.
    //
    //   2. Collapse perceptually-near-duplicate hexes into one
    //      canonical entry. context.dev re-extracts colors from every
    //      image surface it analyzes (logo, hero, page bg) and each
    //      surface contributes slightly-shifted variants of the same
    //      brand color. Without this pass, brands like Dreamworks
    //      surface 9 hexes that visually collapse to 3 colors. With
    //      it, the user sees the 3 canonical ones.
    const exactDeduped = collectExactUnique(rawColors, logos);
    const collapsed = collapseSimilarColors(exactDeduped);
    const colors = collapsed.map((c) => ({
      id: randomUUID(),
      hex: c.hex,
      name: c.name,
    }));

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

/* ---------- Color-normalization helpers ---------- */

interface ColorCandidate {
  hex: string;
  name: string;
}

/* Walks brand.colors plus every logo's per-image colors, returning a
 * list deduped by EXACT hex (case-insensitive). Preserves order so
 * brand-level colors stay ahead of logo-extracted ones. */
function collectExactUnique(
  rawColors: ContextDevColor[],
  logos: ContextDevLogo[],
): ColorCandidate[] {
  const out: ColorCandidate[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const hex = (raw as ContextDevColor).hex;
    if (typeof hex !== 'string' || !hex.trim()) return;
    const key = hex.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ hex: hex.trim(), name: (raw as ContextDevColor).name ?? '' });
  };
  for (const c of rawColors) push(c);
  for (const logo of logos) {
    if (!Array.isArray(logo.colors)) continue;
    for (const c of logo.colors) push(c);
  }
  return out;
}

/* Euclidean RGB distance threshold below which two colors are
 * considered "the same brand color, slightly shifted." 22 keeps
 * obvious near-duplicates from collapsing intentional close pairs.
 *
 * Calibration:
 *   - #0c326f vs #0f2f6e        → ~4.4  (collapses, correct)
 *   - #7b9cc6 vs #8294b4        → ~20.9 (collapses, correct)
 *   - #1d4ed8 vs #2563eb (real
 *     two-shade brand palette)  → ~29.4 (preserved, correct)
 *
 * The 0-441 max range comes from sqrt(255² + 255² + 255²) = pure
 * white vs pure black. 22 is roughly 5% of that. */
const COLOR_DISTANCE_THRESHOLD = 22;

/* Cap on canonical colors returned to the wizard. Real brand
 * palettes are 3-5 colors; anything beyond 6 is almost certainly
 * extraction noise that adds nothing for the user. */
const MAX_CANONICAL_COLORS = 6;

/* Vibrancy threshold for the chromatic/achromatic partition that
 * runs after deduplication. Vibrancy = HSV saturation × HSV value,
 * both in [0..1], so a "vibrant" color has both real hue AND
 * sufficient brightness. Calibration:
 *   - #1d4ed8 (brand blue, sat 0.87, val 0.85) → vibrancy ≈ 0.74 ✓
 *   - #000000 (black, sat 0, val 0)            → 0           ✗
 *   - #808080 (mid gray, sat 0, val 0.5)       → 0           ✗
 *   - #0a0820 (near-black tinted, sat 0.7,
 *              val 0.13)                       → 0.09        ✗
 *   - #2f4858 (dark muted blue, sat 0.34,
 *              val 0.35)                       → 0.12        ✓
 *
 * 0.08 cleanly separates "genuinely a brand color" from
 * "utility/typographic black-white-gray". Tuned down from 0.10 so
 * dark-but-real brand colors don't get demoted. */
const VIBRANCY_THRESHOLD = 0.08;

/* Collapse perceptually-similar hexes into a canonical subset, then
 * promote chromatic colors to the front.
 *
 * Phase 1 — dedup. Walks the input list once. Each candidate either:
 *   - matches an existing kept color within COLOR_DISTANCE_THRESHOLD →
 *     replace the existing entry IF the candidate is more saturated
 *     (HSV S). The brand's actual color is usually the most-saturated
 *     variant; washed-out shifts come from JPEG compression / image
 *     blending against page backgrounds.
 *   - matches nothing → added as a new canonical entry, until we hit
 *     MAX_CANONICAL_COLORS.
 *
 * Phase 2 — chromaticity sort. context.dev orders colors by visual
 * frequency in the source images. For "primary brand color"
 * purposes that's the wrong metric: brands use black/white/gray for
 * typography (high frequency) and a vibrant accent for identity
 * (lower frequency). Users expect the accent at `colors[0]`, not
 * the utility black. Stable partition by vibrancy keeps the
 * relative ordering inside each group, so we're not making
 * editorial calls about which blue beats which red — just moving
 * achromatic colors to the tail.
 *
 * Example for a brand context.dev returns as [black, blue]:
 *   - after dedup: [black, blue]
 *   - after partition: [blue, black]    ← user gets blue as primary
 *
 * For a truly monochrome brand (e.g., only [black, white, gray]):
 *   - all achromatic, all in tail group
 *   - original relative order preserved → no change observable */
function collapseSimilarColors(input: ColorCandidate[]): ColorCandidate[] {
  const kept: Array<ColorCandidate & {
    rgb: [number, number, number];
    saturation: number;
  }> = [];

  for (const candidate of input) {
    const rgb = parseHexToRgb(candidate.hex);
    if (!rgb) continue;
    const saturation = hsvSaturation(rgb);

    const nearIdx = kept.findIndex(
      (k) => rgbEuclideanDistance(k.rgb, rgb) < COLOR_DISTANCE_THRESHOLD,
    );
    if (nearIdx >= 0) {
      if (saturation > kept[nearIdx].saturation) {
        kept[nearIdx] = {
          hex: candidate.hex,
          name: candidate.name,
          rgb,
          saturation,
        };
      }
      continue;
    }

    if (kept.length >= MAX_CANONICAL_COLORS) break;
    kept.push({ hex: candidate.hex, name: candidate.name, rgb, saturation });
  }

  // Stable partition: chromatic first, achromatic at the tail.
  const chromatic: typeof kept = [];
  const achromatic: typeof kept = [];
  for (const c of kept) {
    if (hsvVibrancy(c.rgb) >= VIBRANCY_THRESHOLD) chromatic.push(c);
    else achromatic.push(c);
  }

  return [...chromatic, ...achromatic].map(({ hex, name }) => ({ hex, name }));
}

function parseHexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

function rgbEuclideanDistance(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/* HSV S component, 0..1. We use this instead of HSL because a brand
 * color like pure #ff0000 reads as "maximum saturation" the way
 * users intuit it (HSL would assign saturation 1.0 to #ff8080 too,
 * since saturation in HSL relates to distance from gray at the same
 * lightness). HSV behaves the way you'd want for "which variant is
 * the most vivid?" */
function hsvSaturation([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

/* HSV saturation × HSV value, 0..1. Captures "how much of a real
 * color is this?" — both real hue (saturation) AND enough brightness
 * to read as that hue (value). Used to separate genuine brand-
 * identity colors from utility black/white/gray AND from near-black
 * tinted darks that the eye still reads as black. */
function hsvVibrancy([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b);
  if (max === 0) return 0;
  const min = Math.min(r, g, b);
  const saturation = (max - min) / max;
  const value = max / 255;
  return saturation * value;
}
