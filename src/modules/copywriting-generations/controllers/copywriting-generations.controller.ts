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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CopywritingGeneration } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { DispatchCopywritingDto } from '../dto/dispatch-copywriting.dto';
import { RefineAdTextDto } from '../dto/refine-ad-text.dto';
import { ToggleBookmarkDto } from '../dto/toggle-bookmark.dto';
import { UpdateAdTextDto } from '../dto/update-ad-text.dto';
import { CopywritingDispatchService } from '../services/copywriting-dispatch.service';
import { CopywritingGenerationsService } from '../services/copywriting-generations.service';

// Mixed-prefix controller to match creative-generations:
//   dispatch + flat get/delete/bookmark — under /copywriting-generations
//   list — nested under /projects/:projectId/copywriting-generations
//
// Why not 202 Accepted on dispatch (creative-generations uses it):
//   That flow defers actual generation to GCF + a webhook. Here the
//   variants are fully resolved by the time the response returns, so
//   200 OK with the populated rows reads more honestly to clients.

@ApiTags('copywriting-generations')
@ApiBearerAuth('supabase-jwt')
@Controller()
export class CopywritingGenerationsController {
  constructor(
    private readonly generations: CopywritingGenerationsService,
    private readonly dispatcher: CopywritingDispatchService,
  ) {}

  @Post('copywriting-generations/dispatch')
  @ApiOperation({
    summary: 'Generate N copywriting variants for a project (synchronous)',
  })
  @ApiOkResponse({
    description: 'All variants generated. Rows may be ready or failed; the FE renders both.',
  })
  dispatch(
    @Body() dto: DispatchCopywritingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CopywritingGeneration[]> {
    return this.dispatcher.dispatch(user.id, dto.projectId);
  }

  @Get('projects/:projectId/copywriting-generations')
  @ApiOperation({ summary: 'List copywriting variants of a project (oldest first)' })
  @ApiOkResponse({ description: 'Variants belonging to the project, scoped to caller.' })
  listByProject(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CopywritingGeneration[]> {
    return this.generations.listByProject(projectId, user.id);
  }

  @Get('copywriting-generations/:id')
  @ApiOperation({ summary: 'Fetch one copywriting variant' })
  @ApiNotFoundResponse({ description: 'Variant not found or not owned by caller.' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CopywritingGeneration> {
    return this.generations.findOne(id, user.id);
  }

  @Post('copywriting-generations/:id/refine')
  @ApiOperation({
    summary: 'Refine the ad text via an AI instruction (does not persist)',
  })
  @ApiOkResponse({
    description: 'AI-refined text. Caller is responsible for persisting via PATCH if accepted.',
  })
  @ApiNotFoundResponse({ description: 'Variant not found or not owned by caller.' })
  refine(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RefineAdTextDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ refinedText: string }> {
    return this.generations.refineAdText(id, user.id, dto.currentText, dto.instruction);
  }

  @Patch('copywriting-generations/:id')
  @ApiOperation({ summary: 'Manually edit the generated ad text' })
  @ApiOkResponse({ description: 'Ad text updated; row returned in full.' })
  @ApiNotFoundResponse({ description: 'Variant not found or not owned by caller.' })
  updateAdText(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAdTextDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CopywritingGeneration> {
    return this.generations.updateAdText(id, user.id, dto.adText);
  }

  @Patch('copywriting-generations/:id/bookmark')
  @ApiOperation({ summary: 'Set the bookmark state of a copywriting variant' })
  @ApiOkResponse({ description: 'Bookmark state updated.' })
  @ApiNotFoundResponse({ description: 'Variant not found or not owned by caller.' })
  setBookmarked(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ToggleBookmarkDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string; bookmarked: boolean }> {
    return this.generations.setBookmarked(id, user.id, dto.bookmarked);
  }

  @Delete('copywriting-generations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete one copywriting variant' })
  @ApiNoContentResponse({ description: 'Variant deleted.' })
  @ApiNotFoundResponse({ description: 'Variant not found or not owned by caller.' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.generations.remove(id, user.id);
  }
}
