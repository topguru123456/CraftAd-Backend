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
import type { Brand } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { PlanLimit } from '../../quota/decorators/plan-limit.decorator';
import { CreateBrandDto } from '../dto/create-brand.dto';
import { FetchBrandDto } from '../dto/fetch-brand.dto';
import { UpdateBrandDto } from '../dto/update-brand.dto';
import { BrandFetchService, NormalizedBrand } from '../services/brand-fetch.service';
import { BrandsService, BrandWithProjectCount } from '../services/brands.service';

@ApiTags('brands')
@ApiBearerAuth('supabase-jwt')
@Controller('brands')
export class BrandsController {
  constructor(
    private readonly brands: BrandsService,
    private readonly brandFetch: BrandFetchService,
  ) {}

  @Post('fetch')
  @ApiOperation({
    summary: 'Look up a brand profile from a domain (proxies context.dev)',
  })
  @ApiOkResponse({ description: 'Brand details normalized to the wizard shape.' })
  fetch(@Body() dto: FetchBrandDto): Promise<NormalizedBrand> {
    return this.brandFetch.fetch(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the caller\'s brands' })
  @ApiOkResponse({
    description:
      "Brands owned by the authenticated user, each with a `projectCount`.",
  })
  list(@CurrentUser() user: AuthenticatedUser): Promise<BrandWithProjectCount[]> {
    return this.brands.list(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one brand' })
  @ApiOkResponse({ description: 'The brand.' })
  @ApiNotFoundResponse({ description: 'Brand not found or not owned by caller.' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Brand> {
    return this.brands.findOne(id, user.id);
  }

  @Post()
  @PlanLimit('brands')
  @ApiOperation({ summary: 'Create a brand' })
  @ApiOkResponse({ description: 'The created brand.' })
  create(
    @Body() dto: CreateBrandDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Brand> {
    return this.brands.create(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Partially update a brand' })
  @ApiOkResponse({ description: 'The updated brand.' })
  @ApiNotFoundResponse({ description: 'Brand not found or not owned by caller.' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBrandDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Brand> {
    return this.brands.update(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a brand' })
  @ApiNoContentResponse({ description: 'Brand deleted.' })
  @ApiNotFoundResponse({ description: 'Brand not found or not owned by caller.' })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.brands.remove(id, user.id);
  }
}
