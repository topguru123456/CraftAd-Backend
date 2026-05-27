import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

// Body for PATCH /copywriting-generations/:id. User-driven manual edits
// to the generated copy. We cap at 10k chars — well above any realistic
// ad body length, but bounded so a runaway client paste can't store a
// novel.

export class UpdateAdTextDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  adText!: string;
}
