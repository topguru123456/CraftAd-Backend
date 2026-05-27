import { Injectable } from '@nestjs/common';
import type { Brand, Project } from '@prisma/client';

// Copywriting prompt assembler.
//
// Outputs a {system, user} message pair the OpenAI service hands straight
// to GPT-4o in JSON mode. The system prompt is in English for stronger
// instruction-following on 4o; the user prompt is the variant-specific
// context block — brand, offer, platform tuning, framework choice.
//
// Why one variant per call (not batched 3):
//   Batched JSON-mode requests converge in voice — same model, same
//   system message, same context → similar phrasing across "different"
//   variants. Running 3 parallel calls with a different framework hint
//   per call forces real divergence. Cost goes up ~3x in tokens but
//   text completions are pennies and creative diversity is the point.
//
// Why pass framework IN (vs ask the model to choose):
//   Predictability + variety guarantee. If the model picks, it'll
//   gravitate to AIDA every time and a user clicking "generate" sees
//   three near-identical takes. Pinning the framework per variant
//   guarantees a real strategic spread.

export interface CopywritingPromptInput {
  brand: {
    name: string;
    description: string;
    websiteUrl: string;
    tone: string | null;
  };
  // Resolved Hebrew labels — same shape draftToPromptInput uses for
  // creative-generations, so the FE → BE contract reads the same.
  project: {
    productName: string;
    saleType: string;          // 'product' | 'service'
    audienceType: string;      // 'hot' | 'cold'
    natureHe: string;          // campaign nature display
    locationHe: string;        // conversion location display
    purposeHe: string;         // campaign goal display
    audienceDisplay: string;   // target audience display
    platform: string;          // 'Facebook' | 'Instagram' | ...
    primaryTone: string;       // user-picked tone from offer step
    brief: string;             // long-form description (5000-char cap)
    topics: string[];          // optional anchor keywords
    marketingPromise: string;  // advanced step
    marketingOffer: string;    // advanced step
    callToAction: string;      // advanced step
  };
  framework: CopywritingFramework;
}

// The 5 frameworks the dispatcher rotates across variants. Each entry
// carries:
//   - id:        stable English enum; persisted on the row for analytics
//   - he:        display label rendered on the result card (matches the
//                "אסטרטגיה" pill in the spec mock)
//   - briefing:  short English instruction injected into the prompt so
//                GPT-4o knows the structural beats it must hit
//
// Pinned at 5 because that's enough strategic variety to fill 3 variants
// without repeats; if a 4th variant is ever added per dispatch, expand
// this list before we wrap around.
export interface CopywritingFramework {
  id: string;
  he: string;
  briefing: string;
}

export const COPYWRITING_FRAMEWORKS: readonly CopywritingFramework[] = [
  {
    id: 'AIDA',
    he: 'תשומת לב-עניין-רצון-פעולה',
    briefing:
      'Use the AIDA structure: open with an Attention-grabbing hook, build Interest with a relevant insight, stoke Desire by painting the outcome, close with a decisive Action call.',
  },
  {
    id: 'PAS',
    he: 'בעיה-החמרה-פתרון',
    briefing:
      'Use the PAS structure: name the Problem the audience feels, Agitate the cost of letting it persist, then present the offer as the Solution.',
  },
  {
    id: 'BAB',
    he: 'לפני-אחרי-גשר',
    briefing:
      "Use the BAB structure: describe Before (the audience's current state), After (the changed state with the offer), then the Bridge (how this product/service takes them across).",
  },
  {
    id: 'FAB',
    he: 'תכונות-יתרונות-תועלות',
    briefing:
      'Use the FAB structure: lead with a concrete Feature of the offer, translate it into an Advantage over alternatives, then frame the personal Benefit to the reader.',
  },
  {
    id: '4PS',
    he: 'תמונה-הבטחה-הוכחה-דחיפה',
    briefing:
      'Use the 4Ps structure: Picture the outcome vividly, make the Promise explicit, back it with Proof (concrete details / credibility cue), close with a Push to act now.',
  },
] as const;

// Length + tone tuning per surface. Falls back to a generic 80–150 word
// envelope when we see something we don't have a recipe for — better to
// generate a reasonable-length ad than refuse.
function platformTuning(platform: string): string {
  const key = platform.trim().toLowerCase();
  if (key.includes('instagram') && key.includes('story')) {
    return '20–40 words, conversational, emoji-friendly, one clear CTA. No paragraph breaks.';
  }
  if (key.includes('instagram') || key.includes('tiktok')) {
    return '50–120 words, conversational and warm, sparing emoji use (1–2 max), one clear CTA. Short paragraphs.';
  }
  if (key.includes('facebook')) {
    return '80–150 words, full sentences, persuasive but not pushy, one clear CTA. 2–4 short paragraphs.';
  }
  if (key.includes('linkedin')) {
    return '100–200 words, professional tone, value-first framing, no emoji, one clear CTA. 2–4 paragraphs.';
  }
  if (key.includes('youtube')) {
    return '60–120 words, written for spoken delivery, hook in the first sentence, one clear CTA.';
  }
  return '80–150 words, persuasive, one clear CTA. 2–4 short paragraphs.';
}

// Audience-temperature framing. 'hot' = warm audience already aware of
// the brand/category; 'cold' = first-touch audience that needs context.
function audienceFraming(audienceType: string): string {
  if (audienceType === 'cold') {
    return 'Cold audience: assume zero prior knowledge of the brand or category. Earn attention before asking for anything.';
  }
  if (audienceType === 'hot') {
    return 'Hot audience: they already know the brand or category. Skip basics, focus on a sharp reason to act now.';
  }
  return 'Mixed-temperature audience: open accessibly without over-explaining.';
}

const SYSTEM_PROMPT = [
  'You are a senior Hebrew direct-response copywriter writing high-converting social-media ad copy.',
  '',
  'OUTPUT — return STRICTLY this JSON object, nothing else:',
  '{',
  '  "ad_text": "<the full ad copy in Hebrew, ready to paste into the platform>",',
  '  "tones_used": ["<2–3 short Hebrew tone descriptors that actually characterize what you wrote>"],',
  '  "keywords": ["<2–4 short Hebrew keywords/anchor terms that appear in or summarize the copy>"],',
  '  "conversion_score": <integer 0–100>',
  '}',
  '',
  'CONVERSION_SCORE RUBRIC — your self-rated estimate of how likely this copy is to convert, judged on:',
  '  • clarity of the offer       (vague offer → lower score)',
  '  • CTA strength               (weak / missing CTA → lower score)',
  '  • audience–message fit       (off-tone or off-temperature → lower score)',
  '  • specificity & credibility  (generic platitudes → lower score)',
  '  • urgency / reason-to-act    (no reason to act now → lower score)',
  'Use the FULL range. The median real ad scores 50–70. 80+ must be earned by qualities you can point to specifically. 90+ is rare.',
  '',
  'STYLE RULES:',
  '  • Write in fluent, natural Hebrew — never translated-sounding.',
  '  • RTL punctuation. No mid-sentence English unless the brand name or product is in English.',
  '  • Use real line breaks (\\n) for paragraph spacing — not literal "\\n" strings.',
  '  • Never invent statistics, prices, or credentials not given in the brief. If a number is needed and absent, write copy that works without one.',
  '  • Respect the framework you are told to use — its structural beats must be visible in the copy.',
  '  • One clear CTA at the end matching the user-provided Call To Action verb when given.',
  '',
  'Do not output any text outside the JSON object. No preamble, no markdown fences, no commentary.',
].join('\n');

// Refinement prompt — used by POST /copywriting-generations/:id/refine.
//
// Distinct from the generation prompt because we're NOT producing a
// fresh variant from a brief; we're transforming existing copy
// according to a user instruction. Key constraints:
//   • Preserve facts. The original may include numbers, prices, names,
//     URLs. The refine pass must NEVER invent new ones — its job is
//     stylistic, not factual.
//   • Preserve real newlines. The model's natural tendency is to
//     collapse paragraph breaks; we re-emphasize the rule.
//   • Output a single JSON field `refined_text` so parsing is trivial
//     and the response shape can't drift.
const REFINEMENT_SYSTEM_PROMPT = [
  'You are a senior Hebrew direct-response copywriter. You will receive an existing Hebrew ad copy plus a USER INSTRUCTION describing how to refine it. Rewrite the copy to satisfy the instruction while preserving the core offer, message, and any concrete facts.',
  '',
  'OUTPUT — return STRICTLY this JSON object, nothing else:',
  '{',
  '  "refined_text": "<the refined Hebrew ad copy, with real newlines>"',
  '}',
  '',
  'RULES:',
  '  • Preserve all concrete facts (numbers, prices, brand names, URLs, dates) exactly. Never invent new ones.',
  '  • Preserve real line breaks (\\n) for paragraph spacing — not literal "\\n" strings.',
  '  • Apply the user instruction comprehensively. If the instruction asks to shorten, actually shorten — do not perform a token edit.',
  '  • Stay in fluent, natural Hebrew. RTL punctuation.',
  '  • Keep one clear CTA at the end unless the instruction asks otherwise.',
  '  • Do not output any text outside the JSON object. No preamble, no markdown fences, no commentary.',
].join('\n');

@Injectable()
export class CopywritingPromptService {
  // Returns the {system, user} pair for a single variant call. Caller
  // (CopywritingDispatchService) loops over frameworks and invokes the
  // OpenAI service per framework in parallel.
  build(input: CopywritingPromptInput): { system: string; user: string } {
    const { brand, project, framework } = input;

    const topicsBlock = project.topics.length
      ? project.topics.map((t) => `  • ${t}`).join('\n')
      : '  (none — no topic anchors provided)';

    const briefBlock = project.brief.trim()
      ? project.brief.trim()
      : '(no long-form brief provided — work from the offer fields below)';

    const user = [
      'BRAND',
      `  Name:        ${brand.name || '(unknown)'}`,
      `  Description: ${brand.description || '(none)'}`,
      `  Website:     ${brand.websiteUrl || '(none)'}`,
      `  Tone:        ${brand.tone || '(unset — defer to the project tone below)'}`,
      '',
      'PROJECT',
      `  Product/Service:     ${project.productName || '(unnamed)'}  (${project.saleType || 'unspecified'})`,
      `  Campaign goal:       ${project.purposeHe || '(unspecified)'}`,
      `  Campaign nature:     ${project.natureHe || '(unspecified)'}`,
      `  Conversion location: ${project.locationHe || '(unspecified)'}`,
      `  Target audience:     ${project.audienceDisplay || '(unspecified)'}`,
      `  Audience temp:       ${audienceFraming(project.audienceType)}`,
      `  Platform:            ${project.platform || '(unspecified)'}`,
      `  Length/style:        ${platformTuning(project.platform)}`,
      `  Primary tone:        ${project.primaryTone || '(use brand tone)'}`,
      '',
      'BRIEF',
      briefBlock,
      '',
      'TOPIC ANCHORS (the copy should orbit these themes)',
      topicsBlock,
      '',
      'ADVANCED INPUTS',
      `  Marketing promise:   ${project.marketingPromise || '(unspecified — invent a sharp one from the brief)'}`,
      `  Marketing offer:     ${project.marketingOffer || '(unspecified — use the brief)'}`,
      `  Call to action:      ${project.callToAction || '(unspecified — invent one that matches the conversion location)'}`,
      '',
      'FRAMEWORK FOR THIS VARIANT',
      `  ${framework.id} — ${framework.briefing}`,
      '',
      'Return the JSON object now.',
    ].join('\n');

    return { system: SYSTEM_PROMPT, user };
  }

  // Refinement prompt for an existing piece of copy plus a user
  // instruction. Caller (CopywritingGenerationsService.refineAdText)
  // hands the pair to OpenAiCopywritingService.refine().
  buildRefinement(currentText: string, instruction: string): {
    system: string;
    user: string;
  } {
    const user = [
      'ORIGINAL TEXT:',
      currentText.trim(),
      '',
      'USER INSTRUCTION:',
      instruction.trim(),
      '',
      'Return the JSON object now.',
    ].join('\n');
    return { system: REFINEMENT_SYSTEM_PROMPT, user };
  }
}
