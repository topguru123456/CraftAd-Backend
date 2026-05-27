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
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CreativeGeneration } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { DispatchEditDto } from '../dto/dispatch-edit.dto';
import { DispatchGenerationDto } from '../dto/dispatch-generation.dto';
import { ToggleBookmarkDto } from '../dto/toggle-bookmark.dto';
import { ClearEditService } from '../services/clear-edit.service';
import { CommitEditService } from '../services/commit-edit.service';
import { CreativeGenerationsService } from '../services/creative-generations.service';
import { DispatchEditService } from '../services/dispatch-edit.service';
import { DispatchService } from '../services/dispatch.service';

// Mixed-prefix controller:
//   list — nested under /projects/:projectId/generations (it's a sub-resource)
//   get / delete — flat under /generations/:id (id is globally unique)

@ApiTags('creative-generations')
@ApiBearerAuth('supabase-jwt')
@Controller()
export class CreativeGenerationsController {
  constructor(
    private readonly generations: CreativeGenerationsService,
    private readonly dispatcher: DispatchService,
    private readonly editDispatcher: DispatchEditService,
    private readonly editCommitter: CommitEditService,
    private readonly editCleaner: ClearEditService,
  ) {}

  @Post('generations/dispatch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Kick off a single variant generation via the GCF dispatcher',
  })
  @ApiAcceptedResponse({
    description: 'Variant row created and accepted by the dispatcher.',
  })
  async dispatch(
    @Body() dto: DispatchGenerationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ uid: string; projectId: string; status: string }> {
    const row = await this.dispatcher.dispatch(
      user.id,
      user.email ?? '',
      dto.projectId,
    );
    return { uid: row.id, projectId: row.projectId, status: row.status };
  }

  @Post('generations/:id/edit')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Dispatch an inline edit on an existing variant' })
  @ApiAcceptedResponse({ description: 'Edit dispatched. Candidate lands via Realtime as editStatus=ready.' })
  async dispatchEdit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DispatchEditDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ uid: string; status: string }> {
    return this.editDispatcher.dispatch(id, user.id, dto.prompt);
  }

  @Post('generations/:id/edit/commit')
  @ApiOperation({ summary: 'Save (commit) the candidate edit — promotes edit_image_url to main' })
  @ApiOkResponse({ description: 'Edit committed; scoring re-fires async.' })
  async commitEdit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ imageUrl: string }> {
    return this.editCommitter.commit(id, user.id);
  }

  @Post('generations/:id/edit/clear')
  @ApiOperation({ summary: 'Discard the candidate edit and any orphan storage' })
  @ApiOkResponse({ description: 'Edit state cleared.' })
  async clearEdit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ cleared: true }> {
    return this.editCleaner.clear(id, user.id);
  }

  @Get('projects/:projectId/generations')
  @ApiOperation({ summary: 'List variants of a project (oldest first)' })
  @ApiOkResponse({ description: 'Generations belonging to the project, scoped to caller.' })
  listByProject(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreativeGeneration[]> {
    return this.generations.listByProject(projectId, user.id);
  }

  @Get('generations/:id')
  @ApiOperation({ summary: 'Fetch one generation' })
  @ApiNotFoundResponse({ description: 'Generation not found or not owned by caller.' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreativeGeneration> {
    return this.generations.findOne(id, user.id);
  }

  @Delete('generations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete one generation' })
  @ApiNoContentResponse({ description: 'Generation deleted.' })
  @ApiNotFoundResponse({ description: 'Generation not found or not owned by caller.' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.generations.remove(id, user.id);
  }

  @Patch('generations/:id/bookmark')
  @ApiOperation({ summary: 'Set the bookmark state of an image variant' })
  @ApiOkResponse({ description: 'Bookmark state updated.' })
  @ApiNotFoundResponse({ description: 'Generation not found or not owned by caller.' })
  setBookmarked(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ToggleBookmarkDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ id: string; bookmarked: boolean }> {
    return this.generations.setBookmarked(id, user.id, dto.bookmarked);
  }
}
