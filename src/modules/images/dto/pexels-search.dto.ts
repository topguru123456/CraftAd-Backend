import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

const PER_PAGE_DEFAULT = 24;
const PER_PAGE_MAX = 80; // Pexels API hard cap

export class PexelsSearchDto {
  @ApiProperty({ example: 'sunset over mountains' })
  @IsString()
  @MinLength(1)
  query!: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 24, default: PER_PAGE_DEFAULT, maximum: PER_PAGE_MAX })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PER_PAGE_MAX)
  perPage?: number;
}
