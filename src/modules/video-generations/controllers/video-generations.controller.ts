import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
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
import type { VideoGeneration } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { DispatchVideoDto } from '../dto/dispatch-video.dto';
import { VideoDispatchService } from '../services/video-dispatch.service';
import { VideoGenerationsService } from '../services/video-generations.service';

@ApiTags('video-generations')
@ApiBearerAuth('supabase-jwt')
@Controller()
export class VideoGenerationsController {
  constructor(
    private readonly generations: VideoGenerationsService,
    private readonly dispatcher: VideoDispatchService,
  ) {}

  @Post('video-generations/dispatch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Kick off a single video generation via the GCF video dispatcher (Veo 3)',
  })
  @ApiAcceptedResponse({
    description:
      'Variant row created and POSTed to GCF. Results land via /webhooks/video.',
  })
  async dispatch(
    @Body() dto: DispatchVideoDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ uid: string; projectId: string; status: string }> {
    const row = await this.dispatcher.dispatch(
      user.id,
      user.email ?? '',
      dto.projectId,
    );
    return { uid: row.id, projectId: row.projectId, status: row.status };
  }

  @Get('projects/:projectId/video-generations')
  @ApiOperation({ summary: 'List video variants of a project (oldest first)' })
  @ApiOkResponse({ description: 'Variants belonging to the project, scoped to caller.' })
  listByProject(
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoGeneration[]> {
    return this.generations.listByProject(projectId, user.id);
  }

  @Get('video-generations/:id')
  @ApiOperation({ summary: 'Fetch one video variant' })
  @ApiNotFoundResponse({ description: 'Variant not found or not owned by caller.' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoGeneration> {
    return this.generations.findOne(id, user.id);
  }

  @Delete('video-generations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete one video variant' })
  @ApiNoContentResponse({ description: 'Variant deleted.' })
  @ApiNotFoundResponse({ description: 'Variant not found or not owned by caller.' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.generations.remove(id, user.id);
  }
}
