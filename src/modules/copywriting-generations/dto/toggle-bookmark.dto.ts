import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

// Body for PATCH /copywriting-generations/:id/bookmark. Explicit
// state-passing (vs a toggle endpoint) so retries are idempotent —
// the FE knows what state it wants and the server lands it.

export class ToggleBookmarkDto {
  @ApiProperty()
  @IsBoolean()
  bookmarked!: boolean;
}
