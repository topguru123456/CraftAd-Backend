import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/* Patch body for `/avatars/:id`. Only persona text fields are
 * editable — portrait + ai_blob are server-owned (regenerate via the
 * dedicated endpoint). Every field optional; the service rejects
 * patches with no editable keys.
 *
 * Length caps and array sizes match the original GPT output
 * constraints (handoff doc §8.2): one-Hebrew-word audience ≤25
 * chars, 3-4 interests (we allow up to 6 to give the user breathing
 * room when editing), etc. */
export class UpdateAvatarDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  gender?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  ageMin?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  ageMax?: number;

  @ApiPropertyOptional({ maxLength: 25 })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  targetAudience?: string;

  @ApiPropertyOptional({ maxLength: 800 })
  @IsOptional()
  @IsString()
  @MaxLength(800)
  moreDetails?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  interests?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  pains?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  dreamsGoals?: string[];
}
