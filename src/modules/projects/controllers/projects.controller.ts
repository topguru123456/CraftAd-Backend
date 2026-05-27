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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Project } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PlanLimit } from '../../quota/decorators/plan-limit.decorator';
import { CreateProjectDto } from '../dto/create-project.dto';
import { UpdateProjectDto } from '../dto/update-project.dto';
import { ProjectsService } from '../services/projects.service';

@ApiTags('projects')
@ApiBearerAuth('supabase-jwt')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List the caller\'s projects (optionally filtered by brand)' })
  @ApiQuery({ name: 'brandId', required: false, type: String })
  @ApiOkResponse({ description: 'Projects owned by the authenticated user.' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('brandId') brandId?: string,
  ): Promise<Project[]> {
    return this.projects.list(user.id, brandId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one project' })
  @ApiNotFoundResponse({ description: 'Project not found or not owned by caller.' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Project> {
    return this.projects.findOne(id, user.id);
  }

  @Post()
  @PlanLimit('projects')
  @ApiOperation({ summary: 'Create a project (wizard submit step)' })
  @ApiCreatedResponse({ description: 'The created project.' })
  create(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Project> {
    return this.projects.create(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a project (and other editable scalar fields)' })
  @ApiOkResponse({ description: 'The updated project.' })
  @ApiNotFoundResponse({ description: 'Project not found or not owned by caller.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Project> {
    return this.projects.update(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a project (cascades to its generations)' })
  @ApiNoContentResponse({ description: 'Project deleted.' })
  @ApiNotFoundResponse({ description: 'Project not found or not owned by caller.' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.projects.remove(id, user.id);
  }
}
