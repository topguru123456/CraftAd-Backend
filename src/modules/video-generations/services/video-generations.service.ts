import { Injectable, NotFoundException } from '@nestjs/common';
import { VideoGeneration } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { VeoPollService } from './veo-poll.service';

/* Read + mutation surface for video variants. Mirrors the shape of
 * the sibling generation services, with one critical difference:
 * read paths trigger a Veo poll on in-flight rows BEFORE returning,
 * so the FE's standard "list endpoint" call always returns fresh
 * state.
 *
 * This is the "poll-on-list" pattern that replaces the GCF webhook:
 * the FE's existing 10s poll on useVideoVariants → hits listByProject
 * → triggers backend Veo polls for any in-flight rows → returns the
 * (possibly-just-settled) rows. No background tasks, no webhooks,
 * no Cloud Run "CPU always allocated" assumptions. Self-driving.
 *
 * Dedupe is handled in VeoPollService (in-process Map of in-flight
 * poll promises per row id) so two concurrent list calls during the
 * same poll tick don't blow up Google's free polling endpoint.
 */
@Injectable()
export class VideoGenerationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly poll: VeoPollService,
  ) {}

  /* List variants for a project. Polls Veo for any in-flight rows
   * FIRST, then reads — so caller sees the freshest possible state
   * in a single round-trip. The poll's `await` matters: returning
   * stale data while a poll runs in the background would defeat the
   * purpose. */
  async listByProject(
    projectId: string,
    userId: string,
  ): Promise<VideoGeneration[]> {
    await this.poll.pollProject(projectId, userId);
    return this.prisma.videoGeneration.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /* Single-row fetch. Same poll-then-read pattern. Used when the FE
   * navigates directly to a single variant URL (not currently in
   * v1, but plumbing through here keeps the API uniform). */
  async findOne(id: string, userId: string): Promise<VideoGeneration> {
    /* Best-effort poll — pollOne no-ops if the row is already
     * terminal or doesn't exist, so the throw below remains the
     * authoritative "not found" signal. */
    await this.poll.pollOne(id);
    const row = await this.prisma.videoGeneration.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Video generation not found');
    return row;
  }

  async remove(id: string, userId: string): Promise<{ id: string }> {
    const result = await this.prisma.videoGeneration.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) {
      throw new NotFoundException('Video generation not found');
    }
    return { id };
  }
}
