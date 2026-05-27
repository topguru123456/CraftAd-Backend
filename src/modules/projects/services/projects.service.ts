import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Project } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CreateProjectDto } from '../dto/create-project.dto';
import { UpdateProjectDto } from '../dto/update-project.dto';

// Every query is scoped to userId from the JWT. Cross-user access returns 404.

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, brandId?: string): Promise<Project[]> {
    return this.prisma.project.findMany({
      where: { userId, ...(brandId && { brandId }) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async create(userId: string, dto: CreateProjectDto): Promise<Project> {
    // The brand must be one the caller owns. RLS no longer applies here —
    // we enforce ownership in the app layer with this explicit check.
    const brand = await this.prisma.brand.findFirst({
      where: { id: dto.brandId, userId },
      select: { id: true },
    });
    if (!brand) {
      throw new BadRequestException('Brand not found or not owned by caller');
    }

    return this.prisma.project.create({
      data: {
        userId,
        brandId: dto.brandId,
        draft: dto.draft as object,
        aspectRatio: dto.aspectRatio,
        name: this.deriveName(dto),
        ...(dto.serviceType && { serviceType: dto.serviceType }),
      },
    });
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateProjectDto,
  ): Promise<Project> {
    /* Whitelist what we write. The DTO is currently scoped to `name`,
     * but going through an explicit object (not `...dto`) means
     * adding a new editable column requires touching this method
     * deliberately — no accidental write-through if the DTO grows. */
    const patch: { name?: string } = {};
    if (typeof dto.name === 'string') {
      patch.name = dto.name.trim();
    }

    /* updateMany scoped by (id, userId) so cross-user PATCH attempts
     * return count=0 (404) instead of silently rewriting another
     * user's project. findFirst-then-update would race with concurrent
     * deletes; updateMany is atomic. */
    const result = await this.prisma.project.updateMany({
      where: { id, userId },
      data: patch,
    });
    if (result.count === 0) throw new NotFoundException('Project not found');

    /* Re-read the row so the response carries every field (the caller
     * — wizard rename modal — expects the full project shape, not
     * just the patched columns). The double round-trip is cheap on
     * a single-row PK lookup; the alternative (returning the patch
     * merged into stale FE state) drifts the moment another column
     * is added. */
    const fresh = await this.prisma.project.findFirst({
      where: { id, userId },
    });
    if (!fresh) throw new NotFoundException('Project not found');
    return fresh;
  }

  async remove(id: string, userId: string): Promise<{ id: string }> {
    // CASCADE on the generations relation drops all variants automatically.
    const result = await this.prisma.project.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) throw new NotFoundException('Project not found');
    return { id };
  }

  // Project name precedence: explicit `name` → draft.name → null.
  private deriveName(dto: CreateProjectDto): string | null {
    const fromDto = typeof dto.name === 'string' ? dto.name.trim() : '';
    if (fromDto) return fromDto;
    const fromDraft = (dto.draft as { name?: unknown })?.name;
    if (typeof fromDraft === 'string' && fromDraft.trim()) {
      return fromDraft.trim();
    }
    return null;
  }
}
