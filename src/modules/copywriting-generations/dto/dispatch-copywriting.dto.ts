import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

// Dispatch only needs the project id — the prompt is assembled from the
// project's draft + the brand on the server, and the user_id is taken
// from the JWT. Same shape as DispatchGenerationDto for symmetry.

export class DispatchCopywritingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;
}
