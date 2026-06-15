import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const PROMPT_MAX = 2000;
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class GenerateAiImageDto {
  @ApiProperty({ maxLength: PROMPT_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(PROMPT_MAX)
  prompt!: string;

  // Reference is optional — text-only generation is supported. When
  // present, both base64 + mime must come together so the worker can
  // build the inline_data part; the controller treats them as a pair.
  @ApiPropertyOptional({ description: 'Base64-encoded reference image, no data: prefix.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  referenceImageBase64?: string;

  @ApiPropertyOptional({ enum: ALLOWED_MIMES })
  @IsOptional()
  @IsIn(ALLOWED_MIMES as unknown as string[])
  referenceMime?: (typeof ALLOWED_MIMES)[number];
}
