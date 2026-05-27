import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Avatar } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PlanLimit } from '../../quota/decorators/plan-limit.decorator';
import { UpdateAvatarDto } from '../dto/update-avatar.dto';
import { AvatarsService } from '../services/avatars.service';

// Mixed-prefix routing matches the rest of the modules:
//   list — nested under /brands/:brandId/avatars (it's a sub-resource of brand)
//   create — POST under /brands/:brandId/avatars (creates inside the brand)
//   get / patch / delete / regenerate-portrait — flat under /avatars/:id
//     (id is globally unique; no need to repeat the brand path)

@ApiTags('avatars')
@ApiBearerAuth('supabase-jwt')
@Controller()
export class AvatarsController {
  constructor(private readonly avatars: AvatarsService) {}

  @Get('brands/:brandId/avatars')
  @ApiOperation({ summary: "List a brand's avatars" })
  @ApiOkResponse({ description: 'Avatars belonging to the brand, scoped to caller.' })
  listByBrand(
    @Param('brandId', new ParseUUIDPipe()) brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Avatar[]> {
    return this.avatars.listByBrand(brandId, user.id);
  }

  @Post('brands/:brandId/avatars')
  @PlanLimit('avatars')
  @ApiOperation({ summary: 'Generate a new avatar for the brand (GPT-4o + Gemini)' })
  @ApiCreatedResponse({ description: 'The generated avatar row (portrait may be null if image generation failed).' })
  create(
    @Param('brandId', new ParseUUIDPipe()) brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Avatar> {
    return this.avatars.create(user.id, brandId);
  }

  @Get('avatars/:id')
  @ApiOperation({ summary: 'Fetch one avatar' })
  @ApiNotFoundResponse({ description: 'Avatar not found or not owned by caller.' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Avatar> {
    return this.avatars.findOne(id, user.id);
  }

  @Patch('avatars/:id')
  @ApiOperation({ summary: 'Edit avatar persona text fields' })
  @ApiOkResponse({ description: 'The updated avatar.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAvatarDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Avatar> {
    return this.avatars.update(id, user.id, dto);
  }

  @Post('avatars/:id/regenerate-portrait')
  @ApiOperation({ summary: 'Re-roll the portrait (reuses the existing persona text)' })
  @ApiOkResponse({ description: 'Avatar with the new portrait URL.' })
  regeneratePortrait(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Avatar> {
    return this.avatars.regeneratePortrait(id, user.id);
  }

  @Delete('avatars/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an avatar' })
  @ApiNoContentResponse({ description: 'Avatar deleted.' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.avatars.remove(id, user.id);
  }
}
