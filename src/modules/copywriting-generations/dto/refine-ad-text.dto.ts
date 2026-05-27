import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

// Body for POST /copywriting-generations/:id/refine.
//
// `currentText` is what the user has IN the editor — not the DB row's
// adText. We refine what the user can see; if they've already manually
// edited the textarea (with or without prior refinements), those edits
// are the starting point. The DB is not touched by this endpoint;
// persistence happens via the regular PATCH /:id when the user clicks
// the modal's outer Save button.

export class RefineAdTextDto {
  @ApiProperty({ description: 'The text currently in the editor.' })
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  currentText!: string;

  @ApiProperty({ description: 'Free-form instruction in Hebrew (eg. "קצרו את הטקסט").' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  instruction!: string;
}
