import { Injectable } from '@nestjs/common';
import type { Brand, Project } from '@prisma/client';

/* Product-images prompt assembler.
 *
 * Output: a single prompt string handed verbatim to the GCF image
 * dispatcher (same one campaign-creative uses — the GCF is a thin
 * prompt+images → Gemini → webhook pipe, so what differentiates the
 * two flows is exactly this prompt).
 *
 * Composition:
 *   1. The handoff doc's static "expert art director" preface (verbatim
 *      from §11.6 of the dev handoff). Sets the role + the no-clarifying-
 *      questions instruction so Gemini fills in gaps rather than refusing.
 *   2. A structured user-request block built from the wizard draft +
 *      brand row. Product name + scene description are the creative
 *      anchors; brand name / description / tone / colors are styling
 *      hints (NOT overlays — we explicitly tell the model not to draw
 *      logos or text into the image; that's a separate composition
 *      step, not part of the product photograph itself).
 *
 * Why we don't reuse `creative-generations/PromptAssemblerService`:
 *   That one is tuned for ad creatives (CTA buttons, ≤8-word headlines,
 *   reference-layout mirroring, Hebrew RTL copy). Product images have
 *   none of those concerns — they're product photographs, not ads. A
 *   shared assembler would be a switch statement on serviceType, which
 *   would entangle the two flows' prompt-engineering work. Better to
 *   keep them separate and let each evolve on its own.
 */

const ART_DIRECTOR_PREFACE =
  'You are an expert art director specializing in captivating product ' +
  'imagery. Create a photorealistic, high-resolution product image that ' +
  'is visually stunning and effective for marketing campaigns. Also take ' +
  'into account the user request. Do not ask any questions in case of ' +
  'anything that is unclear, complete the request to the best of your ' +
  'understanding. User request: ';

export interface ProductImagePromptInput {
  brand: {
    name: string;
    description: string;
    tone: string | null;
    primaryColor: string | null;
    secondaryColors: string[];
  };
  project: {
    productName: string;
    imageDescription: string;
  };
}

@Injectable()
export class ProductImagePromptService {
  build(input: ProductImagePromptInput): string {
    const { brand, project } = input;
    const sections: string[] = [];

    /* Lead with the core creative direction: what to show + where. The
     * model treats the first imperative sentences as highest-priority,
     * so the product + scene go first. */
    sections.push(
      `Create a photograph of ${project.productName.trim() || 'the product'}.`,
    );
    if (project.imageDescription.trim()) {
      sections.push(`Scene: ${project.imageDescription.trim()}`);
    }

    /* Brand block — styling hints, NOT overlay instructions. The
     * parenthetical "do not overlay" is intentionally redundant with
     * the closing line; Gemini occasionally ignores constraints set
     * once and we want belt-and-suspenders. */
    const brandLines: string[] = [];
    if (brand.name.trim()) {
      brandLines.push(`- Brand: ${brand.name.trim()}`);
    }
    if (brand.description.trim()) {
      brandLines.push(`- About: ${brand.description.trim()}`);
    }
    if (brand.tone?.trim()) {
      brandLines.push(`- Tone: ${brand.tone.trim()}`);
    }
    if (brand.primaryColor) {
      const palette = [brand.primaryColor, ...brand.secondaryColors]
        .filter(Boolean)
        .join(', ');
      brandLines.push(
        `- Brand colors (use subtly in surfaces, props, or lighting; do not overlay): ${palette}`,
      );
    }
    if (brandLines.length > 0) {
      sections.push(['Brand context:', ...brandLines].join('\n'));
    }

    /* Closing directive. Restates the no-overlay rule explicitly
     * because Gemini's text-rendering pass is over-eager — without
     * this it sometimes drops "BRAND NAME" text into a product shot. */
    sections.push(
      'The product is the hero of the composition. Photorealistic, studio-quality lighting that matches both the scene and the brand tone. Do not overlay any text, logos, watermarks, or brand marks.',
    );

    return ART_DIRECTOR_PREFACE + sections.join('\n\n');
  }

  /* Pure projection from (project, brand) → prompt input shape. Keeps
   * the dispatch service free of draft-shape knowledge so a wizard
   * schema change ripples through ONE spot (here) rather than two. */
  static fromProjectAndBrand(
    project: Project,
    brand: Brand,
  ): ProductImagePromptInput {
    const draft = (project.draft ?? {}) as {
      productName?: unknown;
      imageDescription?: unknown;
    };
    const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

    const colors = Array.isArray(brand.colors)
      ? (brand.colors as Array<{ hex?: unknown }>)
      : [];
    const hexes = colors
      .map((c) => (typeof c?.hex === 'string' ? c.hex : null))
      .filter((h): h is string => Boolean(h));

    return {
      brand: {
        name: brand.name ?? '',
        description: brand.description ?? '',
        tone: brand.tone,
        primaryColor: hexes[0] ?? null,
        secondaryColors: hexes.slice(1),
      },
      project: {
        productName: asStr(draft.productName),
        imageDescription: asStr(draft.imageDescription),
      },
    };
  }
}
