import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppConfigService } from '../../config/config.service';

// Thin wrapper around supabase-js storage operations. One client per
// process, service-role auth (bypasses RLS — only the backend uses this).
// Other features reuse this — no duplicate clients, no scattered service-
// role keys.

export interface UploadResult {
  publicUrl: string;
  path: string;
}

@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private readonly client: SupabaseClient;

  constructor(config: AppConfigService) {
    this.client = createClient(
      config.require('SUPABASE_URL'),
      config.require('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } },
    );
  }

  async upload(
    bucket: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<UploadResult> {
    const { error } = await this.client.storage.from(bucket).upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (error) {
      this.logger.error(
        `Upload to ${bucket}/${path} failed: ${error.message}`,
      );
      throw new Error(error.message);
    }
    const { data } = this.client.storage.from(bucket).getPublicUrl(path);
    return { publicUrl: data.publicUrl, path };
  }

  // Upload to a private bucket — returns only the path, intentionally NOT
  // a public URL. The caller stores the path and resolves to a signed URL
  // on demand via `createSignedUrl`. Used for the clean unwatermarked
  // variants in `creatives-clean`, where exposing a stable public URL
  // would defeat the entire watermark gate.
  async uploadPrivate(
    bucket: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ path: string }> {
    const { error } = await this.client.storage.from(bucket).upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (error) {
      this.logger.error(
        `Private upload to ${bucket}/${path} failed: ${error.message}`,
      );
      throw new Error(error.message);
    }
    return { path };
  }

  // Mint a short-lived signed URL for a private object. The downloads
  // endpoint calls this AFTER ownership + quota checks. expiresInSeconds
  // is the bounded window during which the URL is replayable — keep it
  // short (60s default at the call site) so a leaked URL has minimal
  // half-life.
  async createSignedUrl(
    bucket: string,
    path: string,
    expiresInSeconds: number,
    downloadFilename?: string,
  ): Promise<string> {
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(path, expiresInSeconds, {
        // download=<filename> attaches Content-Disposition so browsers
        // trigger a real download instead of opening the image inline.
        // Without it, the FE has to fetch-as-blob and re-anchor, which
        // wastes ~2× the bandwidth on the user's connection.
        download: downloadFilename ?? true,
      });
    if (error || !data?.signedUrl) {
      this.logger.error(
        `Signed-URL mint for ${bucket}/${path} failed: ${error?.message ?? 'no url'}`,
      );
      throw new Error(error?.message ?? 'Failed to mint signed URL');
    }
    return data.signedUrl;
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.client.storage.from(bucket).remove(paths);
    if (error) {
      this.logger.warn(`Remove from ${bucket} failed: ${error.message}`);
      throw new Error(error.message);
    }
  }

  // Strip the public-URL prefix to recover the in-bucket path. Returns
  // null for URLs that don't belong to this bucket (third-party CDNs etc.)
  // so callers can pipe arbitrary URLs through `remove` without checking
  // ownership first.
  extractPath(publicUrl: string, bucket: string): string | null {
    if (typeof publicUrl !== 'string') return null;
    const marker = `/storage/v1/object/public/${bucket}/`;
    const idx = publicUrl.indexOf(marker);
    return idx === -1 ? null : publicUrl.slice(idx + marker.length);
  }
}
