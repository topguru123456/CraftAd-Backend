import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MinLength,
} from 'class-validator';

export class PexelsImportDto {
  @ApiProperty({ example: 'https://images.pexels.com/photos/123/example.jpg' })
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;

  @ApiPropertyOptional({ example: 12345 })
  @IsOptional()
  @IsInt()
  id?: number;

  // Optional 2-5 char alpha override (jpg / png / webp / gif).
  @ApiPropertyOptional({ example: 'jpg' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @Matches(/^[a-z0-9]{2,5}$/i)
  ext?: string;
}
