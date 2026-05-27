import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

// Body for POST /video-generations/dispatch.
//
// Only the project id — the prompt is assembled from the project's
// draft + brand server-side, mode is derived from
// project.draft.videoSourceType, and the user_id + email come from
// the JWT. Same shape as the other dispatch DTOs across flows.

export class DispatchVideoDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  projectId!: string;
}
