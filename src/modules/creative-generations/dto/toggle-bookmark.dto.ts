import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

// Body for PATCH /generations/:id/bookmark. Mirrors the copywriting
// equivalent — explicit state-passing so retries are idempotent.
export class ToggleBookmarkDto {
  @ApiProperty()
  @IsBoolean()
  bookmarked!: boolean;
}
