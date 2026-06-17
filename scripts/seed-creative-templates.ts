/* One-off seeder that mirrors the Bubble-hosted creative-template pool
 * onto our Supabase storage and emits a JSON manifest the dispatcher
 * can consume at runtime.
 *
 * Why this exists:
 *   The campaign-creative GCF dispatcher payload carries an `example`
 *   image slot — the "ad poster reference" Gemini uses to anchor
 *   composition / style. When the user uploads their own reference,
 *   we pass it through. When they don't, we want a randomized fallback
 *   from a pool of real ad-poster samples — exactly what the previous
 *   Bubble app did. Owning those bytes on our storage (vs. hot-linking
 *   bubble.io) removes the external-CDN dependency and the rate-limit
 *   surface that comes with it.
 *
 * What it does:
 *   1. Reads the CSV at the path given by argv[2] (defaults to the
 *      repo-root copy).
 *   2. Filters rows where category === 'Creative' (per product
 *      decision: only entries the team explicitly tagged as ad
 *      creatives are usable; the empty-category rows are brand-themed
 *      templates that aren't useful as generic references).
 *   3. Normalises the protocol-relative `//bubble.io/...` URL to
 *      https:// and downloads each AVIF.
 *   4. Uploads (upsert=true) to the `creative-templates` Supabase
 *      bucket. The bucket is created public if missing — GCF must be
 *      able to fetch the URL without auth.
 *   5. Emits a manifest at
 *      `src/modules/creative-generations/lib/creative-templates.json`
 *      with `{ generatedAt, bucket, count, templates: [{ name, path,
 *      url }] }`. Idempotent — rerunning overwrites with the latest
 *      bucket state.
 *
 * How to run (from backend/):
 *   npm run seed:creative-templates
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Notes:
 *   - Concurrency is capped at 8 to be neighbourly to Bubble's CDN.
 *   - File extension is preserved verbatim from the CSV `name` field.
 *   - Failures on individual rows are logged + counted but don't abort
 *     the run — manifest is emitted with whatever did upload, and you
 *     can re-run to retry the failures (upsert=true is safe).
 */

import { config as loadDotenv } from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/* The Nest app loads .env via @nestjs/config at boot; standalone tsx
 * scripts don't get that for free, so we load it here explicitly.
 * Path is relative to backend/ so the script can be invoked from
 * anywhere via the npm script. */
loadDotenv({ path: resolve(__dirname, '..', '.env') });

const DEFAULT_CSV_PATH = resolve(
  __dirname,
  '..',
  '..',
  'export_All-Gemini-Templates-modified--_2026-05-21_09-49-26.csv',
);

const BUCKET = 'creative-templates';
const MANIFEST_PATH = resolve(
  __dirname,
  '..',
  'src',
  'modules',
  'creative-generations',
  'lib',
  'creative-templates.json',
);

const CONCURRENCY = 8;

interface CsvRow {
  category: string;
  image: string;
  name: string;
}

interface TemplateEntry {
  name: string;
  path: string;
  url: string;
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.',
    );
  }

  const csvPath = process.argv[2] ?? DEFAULT_CSV_PATH;
  console.log(`Reading CSV: ${csvPath}`);

  const csvText = await readFile(csvPath, 'utf8');
  const rows = parseCsv(csvText);
  const creatives = rows.filter((r) => r.category === 'Creative' && r.image && r.name);
  console.log(`Found ${creatives.length} 'Creative' rows out of ${rows.length} total.`);

  if (creatives.length === 0) {
    throw new Error('No Creative rows to seed — check the CSV path.');
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  await ensureBucket(supabase, BUCKET);

  const results: TemplateEntry[] = [];
  let failed = 0;

  await runWithConcurrency(creatives, CONCURRENCY, async (row, index) => {
    try {
      const entry = await mirrorOne(supabase, row);
      results.push(entry);
      if ((results.length + failed) % 25 === 0) {
        console.log(`Progress: ${results.length} ok, ${failed} failed`);
      }
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[${index + 1}/${creatives.length}] FAILED ${row.name}: ${message}`);
    }
  });

  results.sort((a, b) => a.name.localeCompare(b.name));

  await mkdir(dirname(MANIFEST_PATH), { recursive: true });
  const manifest = {
    generatedAt: new Date().toISOString(),
    bucket: BUCKET,
    count: results.length,
    templates: results,
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`\nDone.`);
  console.log(`  uploaded: ${results.length}`);
  console.log(`  failed  : ${failed}`);
  console.log(`  manifest: ${MANIFEST_PATH}`);
}

async function ensureBucket(supabase: SupabaseClient, bucket: string): Promise<void> {
  const { data: existing, error: listError } = await supabase.storage.getBucket(bucket);
  if (existing && !listError) {
    if (!existing.public) {
      console.warn(
        `Bucket ${bucket} exists but is PRIVATE. GCF needs public URLs — flipping to public.`,
      );
      const { error: updateError } = await supabase.storage.updateBucket(bucket, {
        public: true,
      });
      if (updateError) {
        throw new Error(`Failed to flip ${bucket} to public: ${updateError.message}`);
      }
    }
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(bucket, {
    public: true,
  });
  if (createError) {
    throw new Error(`Failed to create bucket ${bucket}: ${createError.message}`);
  }
  console.log(`Created public bucket: ${bucket}`);
}

async function mirrorOne(
  supabase: SupabaseClient,
  row: CsvRow,
): Promise<TemplateEntry> {
  const sourceUrl = normaliseBubbleUrl(row.image);

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`download HTTP ${response.status} for ${sourceUrl}`);
  }
  const contentType = response.headers.get('content-type') ?? 'image/avif';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error('downloaded payload was empty');
  }

  const path = row.name;
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new Error(`upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { name: row.name, path, url: data.publicUrl };
}

/* CSV parser handling RFC-4180 quoted fields (the date columns contain
 * commas inside quotes, so a naive split-by-comma would corrupt rows).
 * Quote-escape `""` is supported even though the export doesn't use it
 * — costs nothing and removes a future foot-gun. */
function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      current.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      current.push(field);
      field = '';
      if (current.length > 1 || current[0] !== '') rows.push(current);
      current = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || current.length > 0) {
    current.push(field);
    if (current.length > 1 || current[0] !== '') rows.push(current);
  }

  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  const idxCategory = header.indexOf('category');
  const idxImage = header.indexOf('image');
  const idxName = header.indexOf('name');
  if (idxCategory === -1 || idxImage === -1 || idxName === -1) {
    throw new Error(
      `CSV is missing required columns. Header: ${JSON.stringify(header)}`,
    );
  }

  return body.map((cols) => ({
    category: cols[idxCategory] ?? '',
    image: cols[idxImage] ?? '',
    name: cols[idxName] ?? '',
  }));
}

function normaliseBubbleUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `https://${trimmed}`;
}

/* Run an async per-item worker over `items` with at most `limit`
 * in-flight at any time. Simpler than a full p-limit dep — same
 * semantics for this script's use. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
