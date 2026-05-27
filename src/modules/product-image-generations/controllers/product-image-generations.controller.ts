import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CreativeGeneration } from '@prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';
import { DispatchProductImageDto } from '../dto/dispatch-product-image.dto';
import { ProductImageDispatchService } from '../services/product-image-dispatch.service';

/* Product-images controller.
 *
 * Only `dispatch` lives here. The list / get / delete / edit surface is
 * already served by `creative-generations.controller` — product-images
 * rows are stored in the same `creative_generations` table, queries
 * scope on the parent project's serviceType client-side, and the
 * existing webhook handles the result write-back without modification.
 * Re-exposing those endpoints under a /product-image-generations/
 * prefix would just duplicate code with no benefit. */
@ApiTags('product-image-generations')
@ApiBearerAuth('supabase-jwt')
@Controller()
export class ProductImageGenerationsController {
  constructor(private readonly dispatcher: ProductImageDispatchService) {}

  @Post('product-image-generations/dispatch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Fan out N parallel product-image generations against the existing GCF',
  })
  @ApiAcceptedResponse({
    description:
      'Variant rows reserved and dispatched. Results arrive via the existing webhook.',
  })
  async dispatch(
    @Body() dto: DispatchProductImageDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<
    Array<Pick<CreativeGeneration, 'id' | 'projectId' | 'status'>>
  > {
    return this.dispatcher.dispatch(user.id, user.email ?? '', dto.projectId);
  }
}
