import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

const PROMPT_MAX = 2000;
const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export class GenerateAiImageDto {
  @ApiProperty({ maxLength: PROMPT_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(PROMPT_MAX)
  prompt!: string;

  // Base64 payload only (no `data:` prefix). The FE strips that before sending.
  @ApiProperty({ description: 'Base64-encoded reference image, no data: prefix.' })
  @IsString()
  @MinLength(1)
  referenceImageBase64!: string;

  @ApiProperty({ enum: ALLOWED_MIMES })
  @IsIn(ALLOWED_MIMES as unknown as string[])
  referenceMime!: (typeof ALLOWED_MIMES)[number];
}
