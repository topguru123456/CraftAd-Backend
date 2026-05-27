import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { GenerateAiImageDto } from '../dto/generate-ai-image.dto';
import { PexelsImportDto } from '../dto/pexels-import.dto';
import { PexelsSearchDto } from '../dto/pexels-search.dto';
import { RemoveBackgroundDto } from '../dto/remove-background.dto';
import {
  AiImageService,
  GeneratedImage,
} from '../services/ai-image.service';
import { BackgroundRemovalService } from '../services/background-removal.service';
import {
  PexelsImportResult,
  PexelsSearchResult,
  PexelsService,
} from '../services/pexels.service';

// Image-picker endpoints used by the various wizard flows:
//   /images/pexels/search       — Pexels search (no upload, just shaped list)
//   /images/pexels/import       — mirror a Pexels CDN URL into our bucket
//   /images/ai-generate         — Gemini text+ref → generated image in our bucket
//   /images/remove-background   — @imgly/background-removal-node → PNG with alpha
//
// All return a public URL in our `campaign-uploads` bucket that the FE
// stores in draft.images for the dispatch.

@ApiTags('images')
@ApiBearerAuth('supabase-jwt')
@Controller('images')
export class ImagesController {
  constructor(
    private readonly pexels: PexelsService,
    private readonly aiImage: AiImageService,
    private readonly backgroundRemoval: BackgroundRemovalService,
  ) {}

  @Post('pexels/search')
  @ApiOperation({ summary: 'Search Pexels (server-side; key not in browser)' })
  @ApiOkResponse({ description: 'Shaped Pexels search result.' })
  pexelsSearch(@Body() dto: PexelsSearchDto): Promise<PexelsSearchResult> {
    return this.pexels.search(dto);
  }

  @Post('pexels/import')
  @ApiOperation({
    summary: 'Mirror a Pexels CDN URL into the campaign-uploads bucket',
  })
  @ApiOkResponse({ description: 'Public Storage URL for the imported image.' })
  pexelsImport(
    @Body() dto: PexelsImportDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PexelsImportResult> {
    return this.pexels.import(user.id, dto);
  }

  @Post('ai-generate')
  @ApiOperation({ summary: 'Generate an image via Gemini 2.5 Flash Image' })
  @ApiOkResponse({ description: 'Public Storage URL for the generated image.' })
  generate(
    @Body() dto: GenerateAiImageDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GeneratedImage> {
    return this.aiImage.generate(user.id, dto);
  }

  @Post('remove-background')
  @ApiOperation({
    summary: 'Remove the background from a bucket-resident image (PNG out)',
  })
  @ApiOkResponse({
    description: 'Public Storage URL for the background-removed PNG.',
  })
  removeBackground(
    @Body() dto: RemoveBackgroundDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ url: string; path: string }> {
    return this.backgroundRemoval.remove(user.id, dto.imageUrl);
  }
}
