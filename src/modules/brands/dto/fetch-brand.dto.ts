import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class FetchBrandDto {
  @ApiProperty({ example: 'samsung.com', description: 'Domain or full URL.' })
  @IsString()
  @MinLength(1)
  url!: string;

  // Full SupportedLanguage value from context.dev ("hebrew", "english", ...).
  // NOT an ISO code. Empty string = let context.dev auto-detect.
  @ApiPropertyOptional({ example: 'hebrew', default: 'hebrew' })
  @IsOptional()
  @IsString()
  forceLanguage?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  maxSpeed?: boolean;
}
