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
    /* Anchor the label so the model treats brand colors as a palette
     * SOURCE for the example's accent positions, not as a dominant
     * directive that recolors the whole frame. The REFERENCE FIDELITY
     * block establishes the same rule; this label echoes it where
     * the colors actually live. */
    push('Brand Colors (apply at the example\'s accent positions only)', colorsValue);
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

  1. LOGO — the brand mark / wordmark. MUST appear visibly in the
     final composition, used AS-IS (never redrawn or substituted).
     Its absence is a failure mode — reroll rather than ship without it.

  2. PRODUCT — the subject of THIS ad. The hero of the final frame
     must be the subject shown in this image. If it's a physical
     product, feature THAT object; if it's a person or scene,
     feature THAT subject. The EXAMPLE AD does NOT override what
     the product is.

  3. EXAMPLE AD — a style reference. Mimic its composition density,
     color temperament, type weight, decorative motifs, and lighting
     feel. DO NOT use the example's subject as your subject; DO NOT
     copy its product. Style and layout reference only.

  4. FONT REFERENCE — defines the TYPEFACE FAMILY for all Hebrew
     text in the output. Mirror the letterforms in this sample. Do
     not substitute a different font family. The font reference
     dictates WHICH typeface; the EXAMPLE AD dictates how it is
     used (weight, size, treatment).

Failure modes to avoid:
  - Treating the EXAMPLE AD's subject as the product.
  - Treating the PRODUCT image as a style reference.
  - Inventing a product that doesn't appear in either attachment.
  - Substituting the font-reference typeface with a different
    Hebrew font.`;

const INPUT_IMAGES_FALLBACK = `INPUT IMAGES — read this BEFORE anything else:
You receive four images attached. Their roles are FIXED:

  1. LOGO — the brand mark / wordmark. MUST appear visibly, used
     AS-IS. Its absence is a failure mode — reroll rather than ship.

  2. PRODUCT — the subject of THIS ad. The hero of the final frame
     must be the subject shown in this image.

  3. EXAMPLE — pipeline placeholder, IGNORE. Do not mimic it.

  4. FONT REFERENCE — defines the TYPEFACE FAMILY for all Hebrew
     text. Mirror the letterforms; do not substitute a different
     Hebrew font.`;

function inputImagesBlock(referenceMode: CampaignReferenceMode): string {
  return referenceMode === 'user' ? INPUT_IMAGES_USER : INPUT_IMAGES_FALLBACK;
}

/* LEGIBILITY FLOOR — subordinate to REFERENCE FIDELITY.
 *
 * Previously this block was "DESIGN PRINCIPLES" and prescribed clean/
 * minimalist composition, studio-quality lighting, brand-palette
 * dominance, text < 30%. Those rules conflicted with example-mimicry
 * — the model averaged the two and produced a uniform clean-minimal-
 * brand-pink output regardless of which reference was attached. Now
 * stripped to legibility constraints only; everything stylistic is
 * the example's job. */
const LEGIBILITY_FLOOR_BLOCK = `LEGIBILITY FLOOR (apply ON TOP of the example-derived style, do NOT override it):
- Headline ≤ 8 words.
- Sub-text ≤ 1.5 sentences. No paragraphs.
- No AI hand/finger/shape distortions. Re-roll rather than ship a
  broken element.`;

const REFERENCE_FIDELITY_USER = `REFERENCE FIDELITY (HIGHEST PRIORITY — overrides every default below):

The four input images carry TWO different jobs. Treat them separately:
  - LOGO + PRODUCT → IDENTITY ONLY. They define WHAT the brand is and
    WHAT the product looks like. Use them for those properties only —
    not for layout, color temperament, lighting, or mood.
  - EXAMPLE AD → STYLE. This is the dominant source of every visual
    decision listed below. The example IS the brief.

Observe the EXAMPLE AD and reproduce in your output:

  Layout (THE MOST IMPORTANT CATEGORY — the model defaults to logo
  top-right and text in a right column for Hebrew ads. The example's
  actual layout MUST override that default.)
    - Which zone of the canvas holds the headline? Valid positions
      include: top band spanning the full width, bottom band, top-
      left, top-right, centered, left column, right column, text
      overlaying the product, diagonal across the canvas, wrapping
      around the product. Pick the one the example uses, then mirror
      it for RTL reading order.
    - Which zone holds the CTA? (under the headline, separated bottom
      band, inline next to the headline, floating over the product,
      no CTA at all, etc.)
    - Where does the product/subject sit on the canvas? (centered,
      filling one half, bleeding off an edge, a small inset, occupying
      the whole frame as a background)
    - How much negative space surrounds each element? (breathable
      vs dense)

  Palette & lighting
    - What is the example's DOMINANT background tone? (light, dark,
      photographic, gradient, solid color, textured)
    - How many distinct colors does the example use? (monochrome,
      2-tone, 3-tone, full-color photographic)
    - WHERE do accent colors appear? (CTA fill, headline emphasis,
      object highlights, badge)
    - Replace the example's accent colors with the brand colors at
      THE SAME POSITIONS. Do NOT force the brand palette to dominate
      the whole frame — if the example is dark with one accent, the
      output stays dark with the brand color as that accent.
    - Match the example's lighting register (soft/diffuse vs
      hard/dramatic vs flat vs gradient).

  Typography (proportions only — the actual TYPEFACE FAMILY comes
  from the FONT REFERENCE image, never substituted)
    - Headline weight within the font family (light, regular, bold,
      heavy, condensed). Observe the example.
    - Headline size relative to canvas (small caption / medium /
      huge display). Observe the example.
    - Sub-text presence (none, single line, short paragraph).
      Observe the example.
    - Text alignment INSIDE the block (centered, flush right).
      Observe the example.

  CTA button
    - Shape (pill, rounded rect, sharp rect, plain text link).
    - Fill style (solid, outline, gradient, transparent).
    - Icon (none, arrow, plus, custom glyph).
    - Size relative to canvas.

  Mood / treatment
    - Surface treatment (clean studio, lifestyle scene, textured,
      collage, illustration).
    - Energy (calm, urgent, premium, playful, utilitarian).

PRECEDENCE: if any default in this prompt conflicts with what the
example shows, the EXAMPLE wins. Treat drift from the example as a
failure mode and re-roll.`;

/* Recognition hooks, not prescriptions: list named structural patterns
 * the reference ad might belong to so the model has vocabulary other
 * than "single-concept hero + text + CTA". Without this block the
 * model collapses every reference into that default shape, which is
 * the strongest mechanical cause of "every output looks similar".
 *
 * The rule "pick ONE archetype, observe it from the reference, do not
 * blend" is the load-bearing line — without it the model averages
 * archetypes together and lands back at the single-concept default. */
const LAYOUT_ARCHETYPES_USER = `LAYOUT ARCHETYPES — identify which one the reference belongs to:
The reference ad fits ONE of these structural patterns. Identify
which, then re-compose in that same pattern, adapted to the target
aspect ratio and the new brand inputs.

  1. SINGLE-CONCEPT — one focal subject (product or person) + one
     text column + one CTA. Hero and copy occupy distinct zones;
     whitespace separates them.

  2. COMPARISON — two parallel halves (before/after, with/without,
     A vs B). Each side carries its own subject and a brief label;
     the split is visually emphasised (gutter, line, contrasting
     backgrounds).

  3. CENTERED / SYMMETRIC — hero subject sits on the vertical axis
     with concentric layers around it (badges, ribbons, callouts,
     headline above, CTA below). Strong centerline.

  4. SOCIAL PROOF / FLOATING CARDS — testimonials, ratings, or small
     floating panels overlaying or beside the hero. Multiple small
     text blocks rather than one consolidated column.

  5. GRID / BOTTOM STRIP — multi-cell grid of related shots, or a
     dominant hero with a strip of secondary tiles along one edge.
     Used for product ranges or category sweepers.

Rules:
  - Pick ONE archetype. Do not blend two.
  - The archetype is OBSERVED from the reference, not chosen
    independently. If the reference is a comparison ad, do not
    output a single-concept ad just because the brand happens to
    have a single product.
  - Re-compose for the target canvas. If the reference is 1:1 and
    the target is 9:16, the archetype stays the same but the layout
    fills the new aspect natively (vertical stacking for 9:16,
    side-by-side for 16:9).
  - Text-block placement mirrors the reference's placement: centered
    stays centered; left-side text in an LTR reference becomes
    right-side text in the RTL mirror; corners flip to the mirrored
    corner. The text flow INSIDE any block is always right-to-left.`;

const REFERENCE_FIDELITY_FALLBACK = `REFERENCE LAYOUT:
No user-selected reference ad was provided. Compose an original ad
layout from the brief, brand rules, and RTL defaults. The attached
\`example\` image is only a pipeline placeholder — do NOT treat it as
a layout blueprint or copy its composition.`;

/* Hebrew TEXT rules only — applied to the text content itself, not to
 * canvas position. Block placement / which zone of the canvas holds
 * the text is decided entirely by the example (see REFERENCE_FIDELITY
 * + LAYOUT_ARCHETYPES). Previously this block said "headlines and
 * CTAs sit on the right by default" which the model treated as a hard
 * directive — every output ended up logo-top-right + text-right-column
 * regardless of what the reference ad actually showed. */
const HEBREW_RTL_BLOCK = `HEBREW LANGUAGE RULES (governs the text content, NOT canvas position):
- All copy is fully in Hebrew.
- Text reads right-to-left and is right-aligned WITHIN whatever
  container it sits in. (Internal text flow only — this does NOT
  determine where the text block sits on the canvas; block position
  comes from the example.)
- Numeric runs keep natural left-to-right order inside the RTL
  context (e.g. "250,000 ₪", not "₪ 000,250").
- Never mirror or flip Hebrew letters.
- Apply standard Hebrew punctuation rules (commas / periods on the
  visual left of the line, not the right).`;

const CTA_WITH_REFERENCE = `CTA BUTTON LOGIC:
Mirror the example's CTA exactly — presence, shape, fill, padding,
and any icon. If the example has no CTA button, your output has no
CTA button. If the example has a plain text link, your output has a
plain text link. If the example has an icon (arrow, chevron, plus,
custom glyph), include that same icon style.

Single override for RTL: if the example's icon is directional
(arrow, chevron, hand pointing), flip it to point LEFT — RTL forward
direction. Non-directional icons (plus, dot, etc.) are not flipped.`;

const CTA_WITHOUT_REFERENCE = `CTA BUTTON LOGIC:
Default: no icon inside the CTA button unless the brief implies one.
If you include an arrow, it MUST point left (RTL forward direction).`;

const FINAL_WITH_REFERENCE = `LOGO PLACEMENT (read carefully — there is a strong failure mode here):

The model's default for Hebrew ads is to place the brand mark in the
top-right corner. This default is WRONG unless the example actually
uses a top-right brand mark.

Read the example image and identify where its brand mark sits.
Possible positions include any of:
  - inline alongside the headline (the most common position in
    modern editorial ads)
  - centered above the headline
  - centered below the CTA
  - integrated into a footer band that spans the full width
  - inside a corner badge (any of the four corners)
  - bleeding off an edge as a partial wordmark
  - on the product itself (sticker / label / overlay)
  - omitted from the visible frame entirely (very rare; only if the
    reference clearly has no logo)

Place your brand logo in the SAME position the example places its
brand mark, and at roughly the SAME scale relative to the canvas.
If the example does NOT use a top corner, your output MUST NOT use
a top corner. If your draft has the logo top-right and the example
does not, that is a failure — re-roll.

Use the logo image AS-IS. Do not redraw or substitute.

Generate a single finished ad creative.`;

const FINAL_WITHOUT_REFERENCE = `LOGO PLACEMENT:
- Place the logo in the top-left or top-right at roughly 8–12% of
  canvas width unless the composition clearly demands elsewhere.

Generate a single finished ad creative.`;

/* Block order (user-reference mode):
 *   REFERENCE_FIDELITY  — concrete observation checklist of the
 *                         example image; the dominant style source
 *   LAYOUT_ARCHETYPES   — structural-pattern recognition + the
 *                         text-placement-mirrors-reference rule
 *   HEBREW_RTL          — Hebrew typography + RTL text rules
 *   CTA                 — CTA / arrow conventions
 *   LEGIBILITY_FLOOR    — subordinate floor (headline word count,
 *                         no AI distortions). Explicit "do NOT
 *                         override the example" in its own header.
 *   FINAL               — logo placement (the only thing not
 *                         covered in INPUT_IMAGES or above).
 *
 * The fidelity block sits BEFORE the floor because earlier blocks
 * carry more weight in the model. Previously we had DESIGN_PRINCIPLES
 * (clean/minimal/brand-pink) leading the static section — that
 * homogenised every output regardless of which reference attached.
 * The BEHAVIOR block ("act like a creative director, be decisive")
 * was also removed: Gemini 3 Pro is already a decisive executor. */
function staticBlocksWithReference(): string[] {
  return [
    REFERENCE_FIDELITY_USER,
    LAYOUT_ARCHETYPES_USER,
    HEBREW_RTL_BLOCK,
    CTA_WITH_REFERENCE,
    LEGIBILITY_FLOOR_BLOCK,
    FINAL_WITH_REFERENCE,
  ];
}

function staticBlocksWithoutReference(): string[] {
  return [
    REFERENCE_FIDELITY_FALLBACK,
    HEBREW_RTL_BLOCK,
    CTA_WITHOUT_REFERENCE,
    LEGIBILITY_FLOOR_BLOCK,
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
The composition MUST fill the entire ${aspectRatio} canvas edge-to-edge —
no letterboxing, no pillarboxing, no padding bars. If the reference image
has a different shape, RE-compose the layout natively for ${aspectRatio}
rather than preserve the reference's canvas.`;
}
