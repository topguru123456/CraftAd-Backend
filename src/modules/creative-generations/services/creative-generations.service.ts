import { Injectable, NotFoundException } from '@nestjs/common';
import { CreativeGeneration } from '@prisma/client';
import { reconcileStaleGenerations } from '../../../common/generation-errors/reconcile-stale-generations';
import { PrismaService } from '../../../common/prisma/prisma.service';

// Like ProjectsService: scope every query by userId from the JWT.
// "Not found or not yours" → same 404.

@Injectable()
export class CreativeGenerationsService {
  constructor(private readonly prisma: PrismaService) {}

  // List variants for a project. We don't require an ownership check on the
  // project itself here — every generation row carries userId, and we scope
  // on that. A foreign project's id either yields no rows or yields rows the
  // caller doesn't own (which are filtered out by userId).
  async listByProject(
    projectId: string,
    userId: string,
  ): Promise<CreativeGeneration[]> {
    const rows = await this.prisma.creativeGeneration.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'asc' },
    });
    return reconcileStaleGenerations(this.prisma, rows);
  }

  async findOne(id: string, userId: string): Promise<CreativeGeneration> {
    const row = await this.prisma.creativeGeneration.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Generation not found');
    return row;
  }

  async remove(id: string, userId: string): Promise<{ id: string }> {
    const result = await this.prisma.creativeGeneration.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) throw new NotFoundException('Generation not found');
    return { id };
  }

  // Bookmark toggle returns the new state so the FE settles on the
  // server value (matches the copywriting pattern).
  async setBookmarked(
    id: string,
    userId: string,
    bookmarked: boolean,
  ): Promise<{ id: string; bookmarked: boolean }> {
    const result = await this.prisma.creativeGeneration.updateMany({
      where: { id, userId },
      data: { bookmarked },
    });
    if (result.count === 0) throw new NotFoundException('Generation not found');
    return { id, bookmarked };
  }
}
