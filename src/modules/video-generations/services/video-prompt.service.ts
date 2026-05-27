import { Injectable } from '@nestjs/common';
import type { Brand, Project } from '@prisma/client';

/* Video-creative prompt assembler for Veo 3.
 *
 * Output: a single prompt string handed verbatim to VeoApiService for
 * a `predictLongRunning` submit. Veo 3 takes one text prompt plus
 * (optionally) one reference image.
 *
 * Authoring rule (load-bearing): the USER's typed direction leads the
 * prompt and is the dominant share of its surface area. Everything
 * else (mode hint, project context, brand cues, the no-text/no-logo
 * guardrail) is a brief tail so it doesn't crowd out the user's
 * actual creative intent.
 *
 * Why this matters — past failure mode:
 *   An earlier version of this assembler led with an 80-word
 *   "you are an expert director, photorealistic, no on-screen
 *   text/logos/watermarks, take into account user request" preface,
 *   then the user's description, then a multi-line bulleted brand
 *   block, then a 40-word trailing reminder that REPEATED the same
 *   no-text/no-logo guardrail. User text ended up ~10-15% of the
 *   prompt and the "no on-screen text" instruction appeared 3 times.
 *   Result: Veo's output drifted off-brief and the user couldn't
 *   tell whether their description had been read at all. Don't
 *   regress this — keep the user's words first and bulky framing out.
 *
 * Veo prompting guide ordering: subject → action → scene → style.
 * The user's description already encodes subject + action + scene;
 * the brand cues are the only "style" we add, and they're a single
 * trailing line, not a bulleted block.
 *
 * Mode handling:
 *   text  → user description IS the subject; one-sentence mode hint
 *           tells Veo it's an 8s photoreal clip.
 *   image → Veo reads the subject from the reference image; the
 *           one-sentence mode hint tells it to ANIMATE that image
 *           to realize the user's direction. */

export interface VideoPromptInput {
  mode: 'text' | 'image';
  brand: {
    name: string;
    description: string;
    tone: string | null;
    primaryColor: string | null;
    secondaryColors: string[];
  };
  project: {
    /* Project-level context the user typed at step 1 — broad framing
     * (what kind of project this is). Optional; used as a single
     * trailing background line if present. */
    projectDescription: string;
    /* The actual scene/motion direction from step 3. PRIMARY creative
     * anchor — leads the prompt verbatim, no label, no rephrasing. */
    videoDescription: string;
  };
}

@Injectable()
export class VideoPromptService {
  build(input: VideoPromptInput): string {
    const { mode, brand, project } = input;
    const userDirection = project.videoDescription.trim();
    const projectContext = project.projectDescription.trim();
    const sections: string[] = [];

    /* 1. USER DIRECTION — first, verbatim, no label.
     *
     * "First and unlabeled" is deliberate: prefixing with "Scene:" or
     * "User request:" frames the user's words as DATA the model is
     * reading rather than as the INSTRUCTION it's executing. Leading
     * with raw text puts the model in the same posture as a director
     * reading a brief. If the user left it empty we substitute a
     * minimal mode-appropriate stand-in rather than asking the model
     * to invent the whole scene from nothing. */
    if (userDirection) {
      sections.push(userDirection);
    } else {
      sections.push(
        mode === 'image'
          ? 'Animate the supplied product image with tasteful, restrained motion suitable for a short product film.'
          : 'Generic photorealistic product showcase — no specific user direction was provided.',
      );
    }

    /* 2. MODE HINT — one sentence, no more. Just tells Veo the
     * format (8s photoreal) and how to use the reference image when
     * present. Anything longer here starts to compete with the user
     * direction above. */
    sections.push(
      mode === 'image'
        ? 'Render as a photorealistic 8-second clip; animate the supplied product image to realize the direction above. Prefer subtle, intentional camera work (gentle push-in, parallax, slow dolly) over rapid cuts.'
        : 'Render as a photorealistic 8-second clip; the description above is the literal subject of the video. Prefer subtle, intentional camera work over rapid cuts.',
    );

    /* 3. PROJECT BACKGROUND — single line, optional. Step 1's broad
     * project description; useful as flavor but lower priority than
     * the scene direction. Skipped if empty so the prompt doesn't
     * carry empty headers. */
    if (projectContext) {
      sections.push(`Background context: ${projectContext}`);
    }

    /* 4. BRAND CUES — single line, no bullet block. The old multi-
     * line bulleted version padded the prompt with surface area that
     * competed with the user direction. Inlining trades a tiny
     * legibility hit (in a string the model reads, not a human) for
     * keeping the user's intent dominant. */
    const brandParts: string[] = [];
    if (brand.name.trim()) brandParts.push(brand.name.trim());
    if (brand.tone?.trim()) brandParts.push(`tone: ${brand.tone.trim()}`);
    if (brand.primaryColor) {
      const palette = [brand.primaryColor, ...brand.secondaryColors]
        .filter(Boolean)
        .join(', ');
      brandParts.push(`palette ${palette} (as lighting/surface tones, not overlays)`);
    }
    if (brandParts.length > 0) {
      sections.push(`Brand styling cues: ${brandParts.join(' · ')}.`);
    }

    /* 5. LANGUAGE — Hebrew for any audio or in-scene text.
     *
     * Veo 3 generates audio by default and defaults to English (or
     * the prompt's language) for dialogue/voiceover/ambient speech.
     * Without this directive an Israeli-market product clip ships
     * with English narration, which is exactly what the user flagged.
     * Calling out BOTH spoken audio and in-scene text covers the two
     * surfaces Veo can leak English into:
     *   - audible: dialogue, voiceover, ambient speech
     *   - visual: a product label, shop sign, billboard, packaging
     *     text that's part of the scene world (distinct from the
     *     overlay text the next guardrail forbids).
     * Placed BEFORE the no-overlay guardrail so the model reads the
     * positive language instruction before the negative one — order
     * matters for instruction-following in long prompts. */
    sections.push(
      'Language: any spoken audio, voiceover, dialogue, or ambient speech must be in Hebrew. Any text that appears as part of the scene world (signage, product labels, packaging) should also be Hebrew.',
    );

    /* 6. GUARDRAIL — one short sentence, mentioned exactly once.
     * Video models are eager to title-card; without this they'll
     * stamp the brand name or a tagline onto the frame. Repetition
     * doesn't strengthen the instruction in practice (the earlier
     * version said it 3×); it just steals attention from above. */
    sections.push('No on-screen text overlays, captions, watermarks, or rendered logos applied on top of the frame.');

    return sections.join('\n\n');
  }

  /* Pure projection from (project, brand, mode) → prompt input shape.
   * Keeps the dispatch service free of draft-shape knowledge so a
   * wizard schema change ripples through ONE spot. */
  static fromProjectAndBrand(
    project: Project,
    brand: Brand,
    mode: 'text' | 'image',
  ): VideoPromptInput {
    const draft = (project.draft ?? {}) as {
      videoDescription?: unknown;
      description?: unknown;
    };
    const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

    const colors = Array.isArray(brand.colors)
      ? (brand.colors as Array<{ hex?: unknown }>)
      : [];
    const hexes = colors
      .map((c) => (typeof c?.hex === 'string' ? c.hex : null))
      .filter((h): h is string => Boolean(h));

    return {
      mode,
      brand: {
        name: brand.name ?? '',
        description: brand.description ?? '',
        tone: brand.tone,
        primaryColor: hexes[0] ?? null,
        secondaryColors: hexes.slice(1),
      },
      project: {
        /* Step 1 stored `description` (broad project context),
         * step 3 stored `videoDescription` (the actual scene/motion
         * direction). The latter is the primary creative anchor;
         * the former is supplementary framing. */
        projectDescription: asStr(draft.description),
        videoDescription: asStr(draft.videoDescription),
      },
    };
  }
}
