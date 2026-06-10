import { Injectable } from '@nestjs/common';
import type { CampaignReferenceMode } from '../lib/resolve-campaign-gcf-images';

export interface PromptBrandInput {
  websiteUrl: string;
  description: string;
  primaryColor: string;
  secondaryColorsJoined: string;
}

export interface PromptProjectInput {
  productName: string;
  description: string;
  natureHe: string;
  locationHe: string;
  purposeHe: string;
  audienceDisplay: string;
  platform: string;
  landingPageUrl: string;
}

@Injectable()
export class PromptAssemblerService {
  assemble(input: {
    brand: PromptBrandInput;
    project: PromptProjectInput;
    referenceMode: CampaignReferenceMode;
    aspectRatio: string;
  }): string {
    const blocks =
      input.referenceMode === 'user'
        ? staticBlocksWithReference()
        : staticBlocksWithoutReference();
    /* Aspect-ratio block sits second — right after CONTEXT — so the
     * model encounters the canvas constraint before any layout
     * advice from the reference-fidelity / design-principles blocks.
     * Imagen's `parameters.aspectRatio` is the primary signal; this
     * is a textual backstop for the cases where Imagen silently
     * letterboxes a square composition into a 9:16 canvas. */
    return [
      /* INPUT IMAGES sits BEFORE every other block — including
       * CONTEXT — so the model anchors on image-slot semantics
       * before reading anything else. Without this, Gemini can swap
       * the example with the product when their visual content is
       * similar (e.g., both look like full-frame ads), producing
       * randomly-correct outputs the user can't reproduce. */
      inputImagesBlock(input.referenceMode),
      this.buildContextBlock(input),
      aspectRatioBlock(input.aspectRatio),
      ...blocks,
    ].join('\n\n');
  }

  private buildContextBlock({
    brand,
    project,
  }: {
    brand: PromptBrandInput;
    project: PromptProjectInput;
  }): string {
    const lines = ['CONTEXT and INPUTS:'];
    /* Skip blank lines. Inspired-creation passes most project fields
     * as empty strings (no campaign metadata wizard), and rendering
     * "Product Name: " with nothing after it reads to the model as
     * "the product has no name, figure it out yourself" — which
     * pushes it to invent a subject from the attachments and is the
     * proximate cause of the "sometimes uses inspo, sometimes uses
     * product" randomness. Better: omit the line entirely when we
     * have nothing to say. */
    const push = (label: string, value: string | undefined | null) => {
      const trimmed = (value ?? '').trim();
      if (trimmed) lines.push(`${label}: ${trimmed}`);
    };

    push('Business Website', brand.websiteUrl);
    lines.push(
      'Brand Logo: attached as the logo image input (use that file in the composition, not the website).',
    );
    push('Business Brief', brand.description);
    push('Product Name', project.productName);
    push('Product Brief', project.description);
    push('Project Nature', project.natureHe);
    push('The conversion will be in', project.locationHe);
    push('The Campaign target is', project.purposeHe);
    push('General Campaign Brief: Audience -', project.audienceDisplay);
    const secondary = brand.secondaryColorsJoined;
    const colorsValue = secondary
      ? `${brand.primaryColor}, ${secondary}`
      : brand.primaryColor;
    push('Brand Colors', colorsValue);
    push('The Ads are for', project.platform);
    push('Landing page link', project.landingPageUrl);
    return lines.join('\n');
  }
}

/* Image-slot disambiguation. Pins each of the four attached images to
 * an explicit role so the model doesn't have to infer from visual
 * similarity which is the product vs the reference vs the logo.
 *
 * Inspired-creation hits this hardest: the user's product photo and
 * the inspo ad creative can look superficially similar (both
 * full-frame, both branded, both styled), and without this block the
 * model would often swap them — producing outputs whose subject was
 * the inspo's subject instead of the user's product, or vice versa.
 *
 * The fallback variant (no user reference) explicitly tells the model
 * to IGNORE the example slot, since in that path the dispatcher
 * duplicates the logo into the example slot purely so the GCF doesn't
 * reject the request for a missing image. */
const INPUT_IMAGES_USER = `INPUT IMAGES — read this BEFORE anything else:
You receive four images attached. Their roles are FIXED. Do not
swap, recombine, or reinterpret them:

  1. LOGO — the brand mark / wordmark. Place it visibly in the final
     composition exactly as supplied. Never replace it with a
     generated logo.

  2. PRODUCT — the subject of THIS ad. The hero of the final frame
     must be the subject shown in this image. If it's a physical
     product (bottle, can, phone, etc.), feature THAT object. If it
     shows a person or scene, feature THAT subject. The EXAMPLE AD
     below does NOT override what the product is.

  3. EXAMPLE AD — a style reference. Mimic its composition density,
     color temperament, type weight, decorative motifs, and lighting
     feel. DO NOT use the example's subject as your subject; DO NOT
     copy its product. Style and layout reference only.

  4. FONT REFERENCE — a typography sample. Use similar font weight /
     style for headlines and CTAs.

Failure modes to avoid:
  - Treating the EXAMPLE AD's subject as the product.
  - Treating the PRODUCT image as a style reference.
  - Inventing a product that doesn't appear in either attachment.`;

const INPUT_IMAGES_FALLBACK = `INPUT IMAGES — read this BEFORE anything else:
You receive four images attached. Their roles are FIXED:

  1. LOGO — the brand mark / wordmark. Place it visibly in the final
     composition exactly as supplied.

  2. PRODUCT — the subject of THIS ad. The hero of the final frame
     must be the subject shown in this image.

  3. EXAMPLE — pipeline placeholder, IGNORE. This slot is a duplicate
     of the logo and carries no styling intent. Do not mimic it.

  4. FONT REFERENCE — a typography sample. Use similar font weight /
     style for headlines and CTAs.`;

function inputImagesBlock(referenceMode: CampaignReferenceMode): string {
  return referenceMode === 'user' ? INPUT_IMAGES_USER : INPUT_IMAGES_FALLBACK;
}

const BEHAVIOR_BLOCK = `BEHAVIOR:
Act like a Creative Director in a top-tier agency. Prioritize clarity,
aesthetics, and marketing intent. Make decisive layout calls; never
ask clarifying questions. If something is ambiguous, infer from the
brand and product brief and proceed.`;

const DESIGN_PRINCIPLES_BLOCK = `DESIGN PRINCIPLES (non-negotiable):
- Clean & minimalist composition.
- Product is the hero of the frame.
- The brand logo (attached as the \`logo\` image) MUST appear visibly
  in the final composition. Treat its absence as a failure mode —
  reroll the composition rather than ship without it.
- Headline ≤ 8 words.
- Sub-text ≤ 1.5 sentences. No paragraphs.
- Text covers less than 30% of the image area.
- Brand-consistent palette (use the colors provided above).
- Studio-quality lighting; scroll-stopping vibe.
- No AI hand/finger/shape distortions. Re-roll the composition rather
  than ship a broken element.`;

const REFERENCE_FIDELITY_USER = `REFERENCE FIDELITY (highest priority):
The Example Ad image attached is a strict visual blueprint, not a
suggestion. Mimic its overall "vibe" — composition density, color
temperament, type weight, decorative motifs, lighting feel — even
when the product itself differs. Treat deviations as a failure mode
and re-roll the composition rather than ship a version that drifts
from the reference's visual register.`;

const REFERENCE_FIDELITY_FALLBACK = `REFERENCE LAYOUT:
No user-selected reference ad was provided. Compose an original ad
layout from the brief, brand rules, and RTL defaults. The attached
\`example\` image is only a pipeline placeholder — do NOT treat it as
a layout blueprint or copy its composition.`;

const HEBREW_RTL_BLOCK = `HEBREW + RTL (strict):
- All copy is fully in Hebrew.
- All text is right-aligned. Headlines and CTAs sit on the right by
  default unless the reference layout dictates otherwise.
- Numeric runs keep natural left-to-right order inside the RTL
  context (e.g. "250,000 ₪", not "₪ 000,250").
- Never mirror or flip Hebrew letters.
- Apply standard Hebrew punctuation rules (commas / periods on the
  visual left of the line, not the right).`;

const MASTER_RULE_WITH_REFERENCE = `MASTER RULE — LAYOUT vs FLOW:
The PLACEMENT of the text block follows the reference ad:
- reference text centered → output text centered
- reference text in a left block → output text in a right block (the
  RTL mirror)
- reference text in a corner → output text in the mirrored corner.
The INTERNAL FLOW inside the block is always right-to-left,
regardless of where the block sits on the canvas.`;

const MASTER_RULE_WITHOUT_REFERENCE = `MASTER RULE — LAYOUT vs FLOW:
Place the text block using strong RTL marketing layout (headline and
CTA weighted to the right, clear hierarchy). The INTERNAL FLOW inside
the block is always right-to-left.`;

const CTA_WITH_REFERENCE = `CTA BUTTON LOGIC:
Default: no icon inside the CTA button.
If the reference ad has an arrow inside its CTA:
- Include an arrow.
- The arrow MUST point left (RTL forward direction).
- Use a premium/bespoke arrow glyph (not generic clip-art).
- Use generous internal padding around the button copy + arrow.`;

const CTA_WITHOUT_REFERENCE = `CTA BUTTON LOGIC:
Default: no icon inside the CTA button unless the brief implies one.
If you include an arrow, it MUST point left (RTL forward direction).`;

const FINAL_WITH_REFERENCE = `FINAL INSTRUCTIONS:
You receive four attached images: logo, product, example, and font.

LOGO PLACEMENT (REQUIRED — non-negotiable):
The attached \`logo\` image MUST appear in the final composition.
- If the reference layout has an obvious logo position, place the
  brand logo there.
- Otherwise place the logo in the top-left or top-right at roughly
  8–12% of canvas width.
- Use the logo image AS-IS. Do not redraw or invent a substitute.

Other rules:
- Treat the product image as the hero subject.
- Mimic the example ad's layout, vibe, and typography placement.
- Mimic the typography in the font image (weight, letterforms,
  spacing). Do not substitute a different typeface.

Generate a single finished ad creative that respects every block above.`;

const FINAL_WITHOUT_REFERENCE = `FINAL INSTRUCTIONS:
You receive four attached images: logo, product, example, and font.

LOGO PLACEMENT (REQUIRED — non-negotiable):
The attached \`logo\` image MUST appear in the final composition.
- Place the logo in the top-left or top-right at roughly 8–12% of
  canvas width unless the composition clearly demands elsewhere.
- Use the logo image AS-IS. Do not redraw or invent a substitute.

Other rules:
- Treat the product image as the hero subject.
- Do NOT mimic the example image — it is not a reference ad.
- Use the font image for typography weight and letterform cues only.

Generate a single finished ad creative that respects every block above.`;

function staticBlocksWithReference(): string[] {
  return [
    BEHAVIOR_BLOCK,
    DESIGN_PRINCIPLES_BLOCK,
    REFERENCE_FIDELITY_USER,
    HEBREW_RTL_BLOCK,
    MASTER_RULE_WITH_REFERENCE,
    CTA_WITH_REFERENCE,
    FINAL_WITH_REFERENCE,
  ];
}

function staticBlocksWithoutReference(): string[] {
  return [
    BEHAVIOR_BLOCK,
    DESIGN_PRINCIPLES_BLOCK,
    REFERENCE_FIDELITY_FALLBACK,
    HEBREW_RTL_BLOCK,
    MASTER_RULE_WITHOUT_REFERENCE,
    CTA_WITHOUT_REFERENCE,
    FINAL_WITHOUT_REFERENCE,
  ];
}

/* Per-ratio framing. Specific descriptions for the three Imagen-native
 * ratios so the model has concrete vocabulary ("portrait", "square",
 * "wide horizontal") to anchor on. Falls back to a generic phrasing if
 * the dispatcher ever passes a ratio we haven't enumerated here. */
const ASPECT_RATIO_DESCRIPTIONS: Record<string, string> = {
  '9:16':
    '9:16 portrait (vertical, mobile-first — 1080×1920 territory). Compose for a TALL frame: stack the hero subject, brand logo, headline, and CTA vertically.',
  '3:4':
    '3:4 portrait (taller than wide, 1080×1440 territory). Compose for a portrait frame — the hero subject occupies the upper portion with copy + CTA stacked below.',
  '1:1':
    '1:1 square (1080×1080). Compose for a balanced, symmetric frame.',
  '16:9':
    '16:9 landscape (wide horizontal — 1920×1080 territory). Compose for a WIDE frame: the hero subject and copy sit side-by-side.',
};

function aspectRatioBlock(aspectRatio: string): string {
  const framing =
    ASPECT_RATIO_DESCRIPTIONS[aspectRatio] ??
    `${aspectRatio}. Compose for that exact canvas shape.`;
  return `OUTPUT ASPECT RATIO (strictest constraint — overrides reference shape):
Target canvas: ${framing}

Hard rules:
- The composition MUST fill the entire ${aspectRatio} canvas edge-to-edge.
- Do NOT produce a square or differently-shaped image padded with black,
  white, or any colored bars. No letterboxing, no pillarboxing.
- Do NOT preserve the canvas shape of the reference image — if the
  reference is square or 16:9 and the target is ${aspectRatio}, RE-compose
  the layout natively for ${aspectRatio}.
- Treat any letterbox / pillarbox result as a failure mode and re-roll
  the composition rather than ship it.`;
}
