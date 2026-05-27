import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Avatar } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  AvatarBrandInput,
  AvatarDetails,
  OpenAiAvatarService,
} from './openai-avatar.service';
import { GeminiPortraitService } from './gemini-portrait.service';
import { UpdateAvatarDto } from '../dto/update-avatar.dto';

/* Avatars orchestration.
 *
 * Owns the two-step generation pipeline (OpenAI details → Gemini
 * portrait) plus the row CRUD the FE list/edit/delete endpoints
 * call. All queries are scoped by userId from the JWT.
 *
 * QUOTA NOTE: the handoff doc requires server-side enforcement of
 * subscription limits (§10), but the Subscription model isn't in
 * the new Prisma schema yet. Until it lands, quota gating happens
 * client-side via QuotaContext + plans.config.js. When the
 * Subscription model is added, plug the check into `create` here
 * before the AI calls — failing fast is cheaper than burning a
 * GPT + Gemini call only to reject the row at the end. */
@Injectable()
export class AvatarsService {
  private readonly logger = new Logger(AvatarsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenAiAvatarService,
    private readonly gemini: GeminiPortraitService,
  ) {}

  listByBrand(brandId: string, userId: string): Promise<Avatar[]> {
    return this.prisma.avatar.findMany({
      where: { brandId, userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string): Promise<Avatar> {
    const row = await this.prisma.avatar.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Avatar not found');
    return row;
  }

  async create(userId: string, brandId: string): Promise<Avatar> {
    // Brand ownership check — refuses to spend AI credits on a brand
    // the caller doesn't own (would otherwise leak into the wrong
    // user's gallery + still fail at the FK check below).
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, userId },
    });
    if (!brand) {
      throw new BadRequestException('Brand not found or not owned by caller');
    }

    // Stage 1: GPT-4o details. The whole pipeline aborts here if the
    // model refuses or returns an unparseable shape — no half-empty
    // avatar row created.
    const brandInput = projectBrand(brand);
    const detailsResult = await this.openai.generateDetails(brandInput);
    if (!detailsResult.ok) {
      this.logger.warn(`Avatar details failed: ${detailsResult.reason}`);
      throw new BadRequestException(
        'יצירת פרטי האווטאר נכשלה. נסו שוב או עדכנו את פרטי המותג.',
      );
    }

    // Reserve the row before the Gemini call so we have a stable id
    // for the portrait filename + so the user sees an immediate
    // "creating portrait..." card via the FE's optimistic refresh
    // path (Phase 2 wiring). Portrait fields fill in after the
    // image lands; if Gemini fails we surface the error and leave
    // the row with text-only persona (still usable; the user can
    // regenerate the portrait separately later).
    const row = await this.prisma.avatar.create({
      data: {
        brandId,
        userId,
        ...detailsToColumns(detailsResult.details),
        aiBlob: detailsResult.rawBlob as object,
      },
    });

    try {
      const portrait = await this.gemini.generate(
        userId,
        row.id,
        detailsResult.details,
      );
      return this.prisma.avatar.update({
        where: { id: row.id },
        data: { portraitUrl: portrait.url },
      });
    } catch (err) {
      this.logger.error('Avatar portrait generation failed', err);
      // Don't delete the row — the persona text is real, only the
      // portrait failed. The FE can offer "regenerate portrait" on
      // the resulting card. Caller still sees a successful create.
      return row;
    }
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateAvatarDto,
  ): Promise<Avatar> {
    // Explicit whitelist — going through `...dto` would let any new
    // editable field land without a deliberate decision here. The
    // portrait + ai_blob are server-owned; the FE can't patch them
    // via this endpoint.
    const patch: Record<string, unknown> = {};
    if (typeof dto.title === 'string') patch.title = dto.title.trim();
    if (typeof dto.gender === 'string') patch.gender = dto.gender.trim();
    if (typeof dto.ageMin === 'number') patch.ageMin = dto.ageMin;
    if (typeof dto.ageMax === 'number') patch.ageMax = dto.ageMax;
    if (typeof dto.targetAudience === 'string') {
      patch.targetAudience = dto.targetAudience.trim();
    }
    if (typeof dto.moreDetails === 'string') {
      patch.moreDetails = dto.moreDetails.trim();
    }
    if (Array.isArray(dto.interests)) patch.interests = dto.interests;
    if (Array.isArray(dto.pains)) patch.pains = dto.pains;
    if (Array.isArray(dto.dreamsGoals)) patch.dreamsGoals = dto.dreamsGoals;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No editable fields supplied');
    }

    const result = await this.prisma.avatar.updateMany({
      where: { id, userId },
      data: patch,
    });
    if (result.count === 0) throw new NotFoundException('Avatar not found');

    return this.findOne(id, userId);
  }

  async remove(id: string, userId: string): Promise<{ id: string }> {
    const result = await this.prisma.avatar.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) throw new NotFoundException('Avatar not found');
    return { id };
  }

  // Re-roll the portrait without re-running GPT. Reads the existing
  // row's persona fields and feeds them straight to Gemini.
  async regeneratePortrait(id: string, userId: string): Promise<Avatar> {
    const row = await this.findOne(id, userId);
    const details: AvatarDetails = {
      title: row.title ?? '',
      gender: row.gender ?? '',
      ageMin: row.ageMin ?? 0,
      ageMax: row.ageMax ?? 0,
      targetAudience: row.targetAudience ?? '',
      interests: row.interests ?? [],
      pains: row.pains ?? [],
      dreamsGoals: row.dreamsGoals ?? [],
      moreDetails: row.moreDetails ?? '',
    };
    const portrait = await this.gemini.generate(userId, row.id, details);
    return this.prisma.avatar.update({
      where: { id: row.id },
      data: { portraitUrl: portrait.url },
    });
  }
}

// Project a Brand row into the shape OpenAiAvatarService expects.
// Colors arrive as JSON [{hex, ...}, ...]; values is a JSON list of
// Hebrew strings. Both are normalized to flat string arrays so the
// prompt assembler doesn't need to know the wire shape.
function projectBrand(brand: {
  name: string;
  description: string;
  tone: string | null;
  colors: unknown;
  values: unknown;
}): AvatarBrandInput {
  const colors = Array.isArray(brand.colors)
    ? (brand.colors as Array<{ hex?: unknown }>)
    : [];
  const hexes = colors
    .map((c) => (typeof c?.hex === 'string' ? c.hex : null))
    .filter((h): h is string => Boolean(h));

  const values = Array.isArray(brand.values)
    ? (brand.values as unknown[])
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => v.length > 0)
    : [];

  return {
    name: brand.name,
    description: brand.description,
    primaryColor: hexes[0] ?? null,
    secondaryColors: hexes.slice(1),
    tone: brand.tone,
    values,
  };
}

function detailsToColumns(d: AvatarDetails) {
  return {
    title: d.title,
    gender: d.gender || null,
    ageMin: d.ageMin || null,
    ageMax: d.ageMax || null,
    targetAudience: d.targetAudience,
    interests: d.interests,
    pains: d.pains,
    dreamsGoals: d.dreamsGoals,
    moreDetails: d.moreDetails || null,
  };
}
