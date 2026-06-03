/* Aspect-ratio helpers shared across the generation pipeline.
 *
 * Two concerns:
 *   1. Map the wizard's stored ratio id (`story`, `square`, `portrait`,
 *      `landscape`) to the value the GCF dispatcher + Imagen API
 *      understand (`9:16`, `1:1`, `16:9`).
 *   2. Validate a PNG returned by the worker against the requested
 *      ratio — catches the case where Imagen silently produces the
 *      wrong shape (e.g. square padded with black bars) instead of
 *      the 9:16 the user asked for.
 *
 * Kept pure (no Nest decorators) so it can be imported from services,
 * webhooks, and one-off scripts without dragging the DI tree along. */

/* Frontend ratio id → Imagen-API ratio string.
 *
 * `portrait` (4:5) is intentionally coerced to '1:1' until the GCF
 * dispatcher gains real 4:5 support — surfacing as a warning in the
 * dispatch service rather than failing the request.
 *
 * The keys also include the already-mapped values ('1:1', '9:16',
 * '16:9') as identity entries so the helper is idempotent: callers
 * that already hold a mapped value get the same value back. */
export const ASPECT_RATIO_MAP: Readonly<Record<string, string>> = Object.freeze({
  square: '1:1',
  story: '9:16',
  portrait: '1:1',
  landscape: '16:9',
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
});

/* Parse '9:16' → 0.5625. Returns null on garbage input so callers can
 * skip validation gracefully instead of erroring. */
export function parseAspectRatio(
  ratio: string | null | undefined,
): number | null {
  if (typeof ratio !== 'string') return null;
  const m = /^(\d+):(\d+)$/.exec(ratio.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return w / h;
}

/* Read a PNG's declared width × height from the IHDR chunk. Doesn't
 * decode pixel data — just walks the header bytes:
 *   bytes 0..7:   PNG signature (89 50 4E 47 0D 0A 1A 0A)
 *   bytes 8..11:  IHDR chunk length (always 13)
 *   bytes 12..15: 'IHDR' chunk type
 *   bytes 16..19: width  (big-endian uint32)
 *   bytes 20..23: height (big-endian uint32)
 * Returns null for any non-PNG input so callers can skip validation
 * cleanly (e.g. if the worker ever switches to JPEG). */
export function readPngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 24) return null;

  const signatureOk =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (!signatureOk) return null;

  const ihdrOk =
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (!ihdrOk) return null;

  // Big-endian uint32 — shift left by 24/16/8/0 and OR. The >>> 0
  // forces unsigned interpretation in case the high bit is set
  // (would be a >2GB image, but defensive).
  const width =
    ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  const height =
    ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/* Tolerance for ratio drift. Imagen sometimes pads dimensions a few
 * pixels off canonical (e.g. 1024×1792 ≈ 0.571 vs 9:16 = 0.5625).
 * 5% absorbs that without missing a true mismatch like 1080×1080
 * masquerading as 9:16 (drift ≈ 78%). */
const RATIO_TOLERANCE = 0.05;

/* Compare a returned image's dimensions against the requested ratio.
 *
 * Returns:
 *   { ok: true }                            — image matches within tolerance
 *   { ok: false, reason: string }           — image drifted outside tolerance
 *   null                                    — can't validate; callers should skip
 *
 * `null` is the safety hatch: unknown stored ratio, non-PNG bytes, or
 * any other "we don't have enough info to judge" case proceeds as if
 * the check never ran. The validation only rejects when we are
 * certain the ratio is wrong. */
export function validateImageRatio(
  bytes: Uint8Array,
  storedRatio: string | null | undefined,
): { ok: true } | { ok: false; reason: string } | null {
  const apiRatio = storedRatio ? ASPECT_RATIO_MAP[storedRatio] : null;
  if (!apiRatio) return null;

  const expected = parseAspectRatio(apiRatio);
  if (expected === null) return null;

  const dims = readPngDimensions(bytes);
  if (!dims) return null;

  const actual = dims.width / dims.height;
  const drift = Math.abs(actual - expected) / expected;
  if (drift <= RATIO_TOLERANCE) return { ok: true };

  return {
    ok: false,
    reason:
      `aspect ratio mismatch: ${dims.width}×${dims.height} ` +
      `(≈${actual.toFixed(3)}) vs requested ${apiRatio} (${expected.toFixed(3)})`,
  };
}
