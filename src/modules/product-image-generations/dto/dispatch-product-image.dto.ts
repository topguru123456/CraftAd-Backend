import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

// Body for POST /product-image-generations/dispatch.
//
// Only the project id — the prompt is assembled from the project's
// draft + brand server-side, and the user_id + email come from the
// JWT. Same shape as DispatchGenerationDto for symmetry.

export class DispatchProductImageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;
}
