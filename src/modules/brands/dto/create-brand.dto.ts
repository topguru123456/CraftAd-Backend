import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

// JSONB array fields stay loosely typed (any[]) — their shape is owned
// by the FE and validating it deeply here would couple the layers.

export class CreateBrandDto {
  @ApiProperty({ example: 'Acme Co.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  slogan?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  logoUrl?: string;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  logos?: unknown[];

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  colors?: unknown[];

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  values?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  tone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  websiteUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  domain?: string;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  socials?: unknown[];

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  industries?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  primaryLanguage?: string;
}
