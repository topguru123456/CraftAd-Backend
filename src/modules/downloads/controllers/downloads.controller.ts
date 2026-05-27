import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { DownloadTicket, DownloadsService } from '../services/downloads.service';

/* Download endpoint family — issues short-lived signed URLs for files
 * that live in PRIVATE storage. This is the only way to obtain the
 * unwatermarked original of a generated creative. Calling this endpoint
 * is the operation that should be metered against the user's plan when
 * the Subscription model lands. */
@ApiTags('downloads')
@ApiBearerAuth('supabase-jwt')
@Controller('downloads')
export class DownloadsController {
  constructor(private readonly downloads: DownloadsService) {}

  @Post('creative/:id')
  @ApiOperation({
    summary: 'Mint a short-lived signed URL for an unwatermarked creative',
  })
  @ApiOkResponse({
    description:
      'A signed URL valid for ~60 seconds that returns the clean PNG with Content-Disposition: attachment.',
  })
  @ApiNotFoundResponse({
    description: 'Creative not found, not owned by caller, or not yet ready.',
  })
  mintCreative(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DownloadTicket> {
    return this.downloads.mintCreativeDownload(id, user.id);
  }
}
