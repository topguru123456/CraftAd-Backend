import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/* Patch body for `/projects/:id`. Currently scoped to renaming the
 * project — the wizard's draft snapshot, brand, aspect ratio, and
 * service type are all immutable once the row exists (the result
 * grid and dispatch context depend on them). Adding more editable
 * fields later (e.g. archived flag) extends this DTO; the service
 * layer just whitelists what it writes. */
export class UpdateProjectDto {
  @ApiPropertyOptional({
    description: 'New display name for the project.',
    minLength: 1,
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
}
