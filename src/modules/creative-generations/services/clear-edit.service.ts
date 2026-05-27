import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { SupabaseStorageService } from '../../../common/storage/supabase-storage.service';

const CREATIVES_BUCKET = 'creatives';

// Wipe in-flight or unsaved edit state on a variant:
//   1. Delete the edit PNG from Storage (best-effort).
//   2. Null the edit_* columns.
//
// Called by the FE on edit-page mount to wipe stale state from an
// abandoned prior session. Idempotent — rows already clean fast-path.
@Injectable()
export class ClearEditService {
  private readonly logger = new Logger(ClearEditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async clear(variantId: string, userId: string): Promise<{ cleared: true }> {
    const row = await this.prisma.creativeGeneration.findFirst({
      where: { id: variantId, userId },
      select: { id: true, editStatus: true, editImageUrl: true },
    });
    if (!row) throw new NotFoundException('Variant not found');

    // Fast path — nothing to clear.
    if (row.editStatus === null && row.editImageUrl === null) {
      return { cleared: true };
    }

    if (row.editImageUrl) {
      const path = this.storage.extractPath(row.editImageUrl, CREATIVES_BUCKET);
      if (path) {
        try {
          await this.storage.remove(CREATIVES_BUCKET, [path]);
        } catch (err) {
          this.logger.warn(`Edit file cleanup failed: ${err}`);
        }
      }
    }

    await this.prisma.creativeGeneration.update({
      where: { id: variantId },
      data: {
        editStatus: null,
        editImageUrl: null,
        editPrompt: null,
        editErrorMessage: null,
      },
    });

    return { cleared: true };
  }
}
