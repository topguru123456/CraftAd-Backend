import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { removeBackground } from '@imgly/background-removal-node';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';

const BUCKET = 'campaign-uploads';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25MB — comfortable ceiling for a product photo upload

/* Background removal — self-hosted via @imgly/background-removal-node.
 *
 * Architecture choices baked in here:
 *   • Singleton (NestJS default for @Injectable). One model load per
 *     process. Eager-warmed in onModuleInit so the first user request
 *     doesn't pay the ~3–5s disk-to-memory cost.
 *   • Serial inference. We chain calls through `inflight` so two
 *     concurrent requests can't run inference in parallel and OOM the
 *     instance. Throughput is "1 image at a time", which is correct
 *     for a single-vCPU Cloud Run instance — the library is CPU-bound
 *     and parallel calls would just thrash without speeding anything up.
 *   • URL-anchored input. The FE sends the public Supabase URL of an
 *     image already in our bucket (the just-uploaded product photo).
 *     We fetch the bytes server-side, run inference, upload the
 *     PNG-with-alpha output back to the same bucket. Output replaces
 *     the previous draft image; the FE's adoptImage() GCs the
 *     original. We deliberately do NOT delete the source here — the
 *     FE is the owner of that lifecycle (and the same image might be
 *     used in multiple draft.images slots in future flows).
 *
 * SSRF guard: the input URL must belong to OUR bucket. Caller can't
 * point this endpoint at an arbitrary host and use the backend as an
 * image proxy. Anchored to `storage.extractPath(url, BUCKET) != null`.
 */
@Injectable()
export class BackgroundRemovalService implements OnModuleInit {
  private readonly logger = new Logger(BackgroundRemovalService.name);
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: SupabaseStorageService) {}

  /* Eager-warm: load model files into memory at boot so the first
   * real request lands fast. We feed the library a 1×1 PNG — the
   * actual inference completes near-instantly; what we're paying for
   * here is the one-time ONNX runtime + model-weight load. A failure
   * during warm-up is non-fatal; we log it and let the first real
   * request retry (it'll fail loudly with the same error, surfaced
   * to the user).
   *
   * Why a Blob instead of a raw Buffer:
   *   @imgly's internal `imageSourceToImageData` auto-wraps Buffers in
   *   a typeless Blob, then its decoder rejects `blob.type === ''` with
   *   "Unsupported format: ". Passing a pre-typed Blob bypasses the
   *   bug — the decoder reads `image/png` from `blob.type` and dispatches
   *   to sharp's PNG path. Same issue would surface for any caller that
   *   passes raw bytes; our `runInference` path below also constructs a
   *   typed Blob to stay on the supported path. */
  async onModuleInit(): Promise<void> {
    const start = Date.now();
    /* Uint8Array (not Buffer) so the Blob constructor's BlobPart typing
     * stays clean — Node's Buffer is `Buffer<ArrayBufferLike>` which can
     * widen to SharedArrayBuffer in TS, but Blob only accepts plain
     * ArrayBuffer-backed views. `Uint8Array.from` materializes a fresh
     * plain-ArrayBuffer-backed view, which satisfies the type. */
    const tinyBytes = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const tinyBlob = new Blob([tinyBytes], { type: 'image/png' });
    this.logger.log('Warming @imgly background-removal model...');
    try {
      await removeBackground(tinyBlob, { model: 'medium' });
      this.logger.log(
        `BG removal model ready (${Date.now() - start}ms)`,
      );
    } catch (err) {
      this.logger.warn(
        `BG removal warm-up failed (${(err as Error).message}) — ` +
          `first request will pay the load cost`,
      );
    }
  }

  async remove(
    userId: string,
    imageUrl: string,
  ): Promise<{ url: string; path: string }> {
    /* 1. SSRF guard — URL must be in our bucket. extractPath returns
     *    null for foreign hosts; we reject so callers can't use this
     *    endpoint as a "fetch + upload arbitrary images" shortcut. */
    const sourcePath = this.storage.extractPath(imageUrl, BUCKET);
    if (!sourcePath) {
      throw new BadRequestException(
        'תמונה זו אינה נמצאת בדלי שלנו — לא ניתן להסיר רקע ממנה.',
      );
    }

    /* 2. Fetch bytes + sniff MIME from the response header. We hold an
     *    ArrayBuffer (not Buffer / Uint8Array) all the way to the Blob
     *    constructor — `ArrayBuffer` satisfies BlobPart directly,
     *    sidestepping TS's "could be SharedArrayBuffer" widening that
     *    bites typed-array views. */
    const { arrayBuffer, mimeType } = await this.fetchImage(imageUrl);

    /* 3. Inference, serialized through the inflight chain so we never
     *    have two concurrent ONNX runs in the same process. The chain
     *    is awaited, not the inflight slot — that way if one call
     *    rejects, the chain doesn't get poisoned for the next caller. */
    const result = await this.enqueue(() => this.runInference(arrayBuffer, mimeType));

    /* 4. Upload result. PNG-with-alpha so the transparent background
     *    survives — this is the whole point of the operation; a JPEG
     *    encode would re-introduce a (white) background. */
    const path = `${userId}/bg-removed-${Date.now()}.png`;
    const uploaded = await this.storage.upload(
      BUCKET,
      path,
      result,
      'image/png',
    );

    return { url: uploaded.publicUrl, path: uploaded.path };
  }

  /* Promise-chained mutex. Each call appends itself to `inflight`;
   * the caller awaits the chain head, not the slot itself, so a
   * thrown error in one job propagates to its caller without
   * blocking subsequent jobs from running. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.inflight.then(work, work);
    /* Catch on the chain itself (not the returned promise) so a
     * rejection here doesn't surface as an unhandled rejection. */
    this.inflight = next.catch(() => {});
    return next;
  }

  private async runInference(
    arrayBuffer: ArrayBuffer,
    mimeType: string,
  ): Promise<Uint8Array> {
    const start = Date.now();
    /* Construct a typed Blob from (ArrayBuffer + MIME). The lib's
     * decoder dispatches on `blob.type` — passing raw bytes via the
     * lib's own auto-wrap would land in its typeless-Blob path and
     * fail (see onModuleInit doc-comment). Allowlist is the same one
     * its decoder supports; anything outside gets coerced to
     * `application/octet-stream`, which the decoder also handles
     * (sharp does its own magic-byte sniff for that branch). */
    const safeMime = ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
      ? mimeType
      : 'application/octet-stream';
    const inputBlob = new Blob([arrayBuffer], { type: safeMime });
    try {
      const blob = await removeBackground(inputBlob, {
        model: 'medium',
        output: { format: 'image/png', quality: 0.9 },
      });
      const outBuffer = await blob.arrayBuffer();
      const out = new Uint8Array(outBuffer);
      this.logger.log(
        `BG removal: ${arrayBuffer.byteLength} → ${out.byteLength} bytes ` +
          `in ${Date.now() - start}ms (in=${safeMime})`,
      );
      return out;
    } catch (err) {
      this.logger.error('BG removal inference failed', err);
      throw new BadGatewayException(
        'הסרת הרקע נכשלה. ייתכן שהתמונה פגומה או גדולה מדי — נסו שוב.',
      );
    }
  }

  private async fetchImage(
    url: string,
  ): Promise<{ arrayBuffer: ArrayBuffer; mimeType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new BadGatewayException(
          `לא ניתן לטעון את התמונה (${response.status})`,
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_INPUT_BYTES) {
        throw new BadRequestException(
          'התמונה גדולה מ-25MB — אנא הקטינו ונסו שוב.',
        );
      }
      /* Read MIME from the Content-Type header so we can hand the
       * decoder a typed Blob. Supabase Storage public URLs always
       * include this header (set at upload time from the file's
       * declared type). Strip any `; charset=...` suffix — the lib's
       * MIME parser handles it, but the cleaner value is also what
       * we want in our logs. Default to empty string and let the
       * caller's allowlist coerce to octet-stream. */
      const rawType = response.headers.get('content-type') ?? '';
      const mimeType = rawType.split(';')[0]?.trim().toLowerCase() ?? '';
      return { arrayBuffer, mimeType };
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof BadGatewayException) {
        throw err;
      }
      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new BadGatewayException(
        isAbort
          ? 'טעינת התמונה ארכה זמן רב מדי'
          : 'שגיאה בטעינת התמונה',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
