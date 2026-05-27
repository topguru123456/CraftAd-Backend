import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

// Edit dispatch needs just a Hebrew/English instruction. variantId comes
// from the route param; user_id from the JWT; aspect ratio + source image
// are resolved server-side from the existing variant row.

const MAX_PROMPT_LEN = 500;

export class DispatchEditDto {
  @ApiProperty({ example: 'הוסף קולאז\' של פרחים ברקע' })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PROMPT_LEN)
  prompt!: string;
}
