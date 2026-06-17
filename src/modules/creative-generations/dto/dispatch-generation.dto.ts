import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/* Dispatch payload.
 *
 *   projectId — the project whose draft + brand drive the generation.
 *               user_id is taken from the JWT, prompt is assembled
 *               server-side from `project.draft`.
 *
 *   count     — number of variants to dispatch in this batch (1-5).
 *               The server picks N distinct ad-reference templates
 *               in one shot when the user didn't supply their own,
 *               so all variants in the same batch get different
 *               example slots. Per-variant dispatches couldn't
 *               coordinate that distinct-pick property.
 *
 * The cap of 5 is a safety bound — today's wizards request 3; raising
 * the wire cap further would also require GCF-side rate-limit
 * consideration. */

const DEFAULT_COUNT = 1;
const MIN_COUNT = 1;
const MAX_COUNT = 5;

export class DispatchGenerationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;

  @ApiPropertyOptional({
    minimum: MIN_COUNT,
    maximum: MAX_COUNT,
    default: DEFAULT_COUNT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_COUNT)
  @Max(MAX_COUNT)
  count?: number = DEFAULT_COUNT;
}

export const DISPATCH_DEFAULT_COUNT = DEFAULT_COUNT;
