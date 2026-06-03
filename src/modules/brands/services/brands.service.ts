import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Brand, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AvatarsService } from '../../avatars/services/avatars.service';
import { CreateBrandDto } from '../dto/create-brand.dto';
import { UpdateBrandDto } from '../dto/update-brand.dto';

// Every query is scoped to userId from the JWT. A brand owned by someone
// else returns 404 (not 403) so we don't leak which ids exist.

export type BrandWithCounts = Brand & {
  projectCount: number;
  avatarCount: number;
};

@Injectable()
export class BrandsService {
  private readonly logger = new Logger(BrandsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly avatars: AvatarsService,
  ) {}

  async list(userId: string): Promise<BrandWithCounts[]> {
    const rows = await this.prisma.brand.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { projects: true, avatars: true } } },
    });
    return rows.map(({ _count, ...brand }) => ({
      ...brand,
      projectCount: _count.projects,
      avatarCount: _count.avatars,
    }));
  }

  async findOne(id: string, userId: string): Promise<Brand> {
    const brand = await this.prisma.brand.findFirst({
      where: { id, userId },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async create(userId: string, dto: CreateBrandDto): Promise<Brand> {
    const brand = await this.prisma.brand.create({
      data: this.toCreateData(userId, dto),
    });

    /* Auto-trigger the brand's first avatar. Fire-and-forget because
     * the pipeline is slow (~20–40s: GPT-4o persona → Gemini portrait)
     * and we don't want to block the brand-create HTTP response on it.
     *
     * Failure here MUST NEVER fail brand creation — the user always
     * gets their brand back, and can manually trigger an avatar from
     * the Avatars page if the auto-attempt didn't produce one. The
     * `.catch` swallows the rejection so Node won't log an unhandled-
     * rejection warning; `void` documents the intent for readers and
     * appeases the no-floating-promises lint rule. */
    void this.avatars.create(userId, brand.id).catch((err) => {
      this.logger.warn(
        `Auto-avatar generation failed for brand ${brand.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    return brand;
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateBrandDto,
  ): Promise<Brand> {
    // updateMany lets us scope the WHERE by userId in one round-trip.
    // count === 0 means "not found or not yours" — same 404 either way.
    const result = await this.prisma.brand.updateMany({
      where: { id, userId },
      data: this.toUpdateData(dto),
    });
    if (result.count === 0) throw new NotFoundException('Brand not found');
    return this.findOne(id, userId);
  }

  async remove(id: string, userId: string): Promise<{ id: string }> {
    const result = await this.prisma.brand.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) throw new NotFoundException('Brand not found');
    return { id };
  }

  private toCreateData(
    userId: string,
    dto: CreateBrandDto,
  ): Prisma.BrandUncheckedCreateInput {
    return {
      userId,
      name: dto.name.trim(),
      description: dto.description ?? '',
      slogan: dto.slogan ?? '',
      logoUrl: dto.logoUrl ?? null,
      logos: (dto.logos ?? []) as Prisma.InputJsonValue,
      colors: (dto.colors ?? []) as Prisma.InputJsonValue,
      values: (dto.values ?? []) as Prisma.InputJsonValue,
      tone: dto.tone ?? null,
      websiteUrl: dto.websiteUrl ?? '',
      domain: dto.domain ?? null,
      socials: (dto.socials ?? []) as Prisma.InputJsonValue,
      industries: (dto.industries ?? []) as Prisma.InputJsonValue,
      primaryLanguage: dto.primaryLanguage ?? null,
    };
  }

  private toUpdateData(dto: UpdateBrandDto): Prisma.BrandUncheckedUpdateInput {
    const data: Prisma.BrandUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description ?? '';
    if (dto.slogan !== undefined) data.slogan = dto.slogan ?? '';
    if (dto.logoUrl !== undefined) data.logoUrl = dto.logoUrl ?? null;
    if (dto.logos !== undefined) data.logos = dto.logos as Prisma.InputJsonValue;
    if (dto.colors !== undefined) data.colors = dto.colors as Prisma.InputJsonValue;
    if (dto.values !== undefined) data.values = dto.values as Prisma.InputJsonValue;
    if (dto.tone !== undefined) data.tone = dto.tone ?? null;
    if (dto.websiteUrl !== undefined) data.websiteUrl = dto.websiteUrl ?? '';
    if (dto.domain !== undefined) data.domain = dto.domain ?? null;
    if (dto.socials !== undefined) data.socials = dto.socials as Prisma.InputJsonValue;
    if (dto.industries !== undefined) data.industries = dto.industries as Prisma.InputJsonValue;
    if (dto.primaryLanguage !== undefined) data.primaryLanguage = dto.primaryLanguage ?? null;
    return data;
  }
}
