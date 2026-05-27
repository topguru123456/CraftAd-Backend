import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/* Server-side watermarking for generated creatives.
 *
 * Why this exists:
 *   The user-visible image on every card is a WATERMARKED variant. The
 *   clean original lives in a private bucket and only comes out via the
 *   /downloads endpoint after a quota check. Without that split, anyone
 *   could curl the public URL and bypass the download counter.
 *
 * Approach (diagonal repeating tile of the Craftad logo):
 *   1. Load the brand logo PNG from disk on demand, cached in memory.
 *   2. For each watermark call, scale the logo to a size proportional
 *      to the source image's shorter edge (≈ 5 tiles across), so the
 *      visual density is consistent across 1:1 / 16:9 / 9:16 outputs.
 *   3. Multiply the logo's alpha channel down to ~25% — sharp has no
 *      single-knob opacity, so we composite a 1×1 pixel at alpha=64
 *      with blend=dest-in, which multiplies the destination alpha.
 *   4. Rotate −30° with a transparent background so the corners stay
 *      clear after rotation.
 *   5. Pad the rotated logo with extra transparent space so when sharp
 *      tiles it across the source, there's breathing room between the
 *      logos — tile=true repeats at the overlay's exact dimensions, so
 *      padding IS the gap.
 *   6. Composite the padded overlay over the source with tile=true.
 *
 * Graceful degradation:
 *   The Craftad logo lives at <repo>/backend/assets/watermark.png. If
 *   the file is missing at first call (typical during initial setup
 *   before the asset has been dropped in), the service logs a warning
 *   ONCE and returns the source bytes unchanged. The webhook will then
 *   store the same bytes to both buckets — display still works, the
 *   watermark just isn't applied yet. Restart after dropping the
 *   asset and the next webhook produces a real watermark.
 *
 * Concurrency:
 *   sharp is sync-CPU but releases the event loop per operation, so a
 *   serial mutex like BackgroundRemovalService uses isn't necessary —
 *   sharp's libvips pipeline handles parallelism internally. Webhooks
 *   land one creative at a time anyway (one POST per Cloud Tasks fire).
 */

const ASSET_PATH = path.resolve(
  process.cwd(),
  'assets',
  'watermark.png',
);

// Visible footprint controls. Tuned against 1024² generations: 5 tiles
// across the shorter edge with ~80px of padding around each tile reads
// as a "diagonal lattice" without obliterating the underlying image.
const TILES_ACROSS_SHORTER_EDGE = 5;
const TILE_PADDING = 80;
const ROTATION_DEGREES = -30;
const OPACITY = 0.25;

@Injectable()
export class WatermarkService implements OnModuleInit {
  private readonly logger = new Logger(WatermarkService.name);
  private logoBuffer: Buffer | null = null;
  private logoMissingLogged = false;

  // Eager-load the asset at boot so the first real webhook doesn't pay
  // the disk-read cost. Missing asset is non-fatal — the service just
  // no-ops every call until the file appears and the server restarts.
  async onModuleInit(): Promise<void> {
    try {
      this.logoBuffer = await fs.readFile(ASSET_PATH);
      this.logger.log(`Watermark asset loaded (${this.logoBuffer.length} bytes)`);
    } catch (err) {
      this.logger.warn(
        `Watermark asset NOT FOUND at ${ASSET_PATH} — watermarking will no-op. ` +
          `Drop a transparent-bg PNG there and restart to enable. ` +
          `(${(err as Error).message})`,
      );
    }
  }

  /* Apply the diagonal-tile watermark. Returns the source bytes unchanged
   * if the asset isn't loaded — caller decides what to do with the result. */
  async apply(sourceBytes: Uint8Array): Promise<Uint8Array> {
    if (!this.logoBuffer) {
      if (!this.logoMissingLogged) {
        this.logger.warn('Watermark asset not loaded; passing source through');
        this.logoMissingLogged = true;
      }
      return sourceBytes;
    }

    try {
      const metadata = await sharp(sourceBytes).metadata();
      const shorterEdge = Math.min(metadata.width ?? 1024, metadata.height ?? 1024);
      const tileWidth = Math.max(80, Math.round(shorterEdge / TILES_ACROSS_SHORTER_EDGE));

      // Step 1-3: resize, drop opacity, rotate. Resize first so the
      // opacity multiplication and rotation operate on the final scale —
      // doing it the other way wastes pixels and rounds rotation more.
      const semiTransparent = await sharp(this.logoBuffer)
        .resize({ width: tileWidth, withoutEnlargement: false })
        .ensureAlpha()
        .composite([
          {
            input: Buffer.from([0, 0, 0, Math.round(255 * OPACITY)]),
            raw: { width: 1, height: 1, channels: 4 },
            tile: true,
            blend: 'dest-in',
          },
        ])
        .toBuffer();

      const rotated = await sharp(semiTransparent)
        .rotate(ROTATION_DEGREES, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();

      // Step 4: pad with transparent space. tile=true repeats at the
      // overlay's exact bounding-box; padding IS the spacing between
      // logo tiles when the pattern repeats across the source.
      const padded = await sharp(rotated)
        .extend({
          top: TILE_PADDING,
          bottom: TILE_PADDING,
          left: TILE_PADDING,
          right: TILE_PADDING,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .toBuffer();

      // Step 5: tile-composite onto the source. Output format follows
      // source — if source was PNG with alpha, we preserve it; JPEG
      // sources come back as PNG (sharp upgrades to preserve overlay
      // edges). Either way the bytes go to the public bucket as PNG.
      const out = await sharp(sourceBytes)
        .composite([{ input: padded, tile: true, blend: 'over' }])
        .png()
        .toBuffer();

      return new Uint8Array(out);
    } catch (err) {
      // Failing closed (no watermark) is worse than failing open (no
      // image at all). Log loudly and pass through so the user still
      // gets their creative; the unwatermarked variant will display but
      // the download path is still gated on the signed-URL endpoint.
      this.logger.error(
        `Watermark composite failed; passing source through: ${
          (err as Error).message
        }`,
      );
      return sourceBytes;
    }
  }

  // For tests + the FE telling the user whether watermarking is live.
  get isReady(): boolean {
    return this.logoBuffer !== null;
  }
}
