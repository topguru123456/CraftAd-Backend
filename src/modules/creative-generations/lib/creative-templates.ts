import { Logger } from '@nestjs/common';
import manifest from './creative-templates.json';

/* Random-pick utility for the campaign-creative GCF `example` image
 * slot when the user didn't upload their own reference ad.
 *
 * Backing data: `creative-templates.json` — emitted by the
 * `seed:creative-templates` script that mirrors the Bubble-era ad
 * sample pool onto our Supabase `creative-templates` bucket. The
 * manifest is committed alongside the codebase; rerunning the seed
 * overwrites it.
 *
 * Picks are DISTINCT within a single batch — when three variants are
 * dispatched together, each gets a different template. This is the
 * load-bearing reason the controller batches: per-variant requests
 * couldn't coordinate the distinct-pick property.
 *
 * Safe fallback: if the manifest is empty (seed never ran, or all
 * uploads failed), `pickRandomExamples` returns an empty array and
 * the dispatcher falls back to the previous logo-duplication
 * behaviour. The app boots and dispatches still work — just without
 * the variety this feature is intended to add.
 */

interface TemplateEntry {
  name: string;
  path: string;
  url: string;
}

interface Manifest {
  generatedAt?: string;
  bucket?: string;
  count?: number;
  templates?: TemplateEntry[];
}

const logger = new Logger('CreativeTemplates');

const POOL: readonly TemplateEntry[] = (() => {
  const list = (manifest as Manifest).templates ?? [];
  if (list.length === 0) {
    logger.warn(
      'Creative-templates manifest is empty. Run `npm run seed:creative-templates`.',
    );
  } else {
    logger.log(`Loaded ${list.length} creative-template references.`);
  }
  return list;
})();

/**
 * Returns up to `count` DISTINCT randomly-picked template URLs. If the
 * pool is smaller than `count`, returns as many as are available (the
 * caller decides how to handle the shortfall — typically by repeating
 * picks or falling back to the logo-duplicate path). Returns an empty
 * array when the manifest is empty.
 */
export function pickRandomExamples(count: number): string[] {
  if (count <= 0 || POOL.length === 0) return [];

  /* Fisher–Yates partial shuffle — O(min(count, pool)) without
   * mutating the shared pool. Materialising the index list (one
   * Int32-sized array per call) is well under any GC concern at the
   * scales we see (count ≤ ~5). */
  const n = Math.min(count, POOL.length);
  const indices = Array.from({ length: POOL.length }, (_, i) => i);
  const picks: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (POOL.length - i));
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
    picks.push(POOL[indices[i]].url);
  }
  return picks;
}

/** Exposed for diagnostics / tests. Do not mutate. */
export function getCreativeTemplatePoolSize(): number {
  return POOL.length;
}
