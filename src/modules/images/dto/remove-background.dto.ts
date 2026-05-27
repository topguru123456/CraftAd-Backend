import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUrl, MaxLength } from 'class-validator';

// Body for POST /images/remove-background. The URL must point at an
// image already uploaded to our `campaign-uploads` bucket — the service
// rejects foreign URLs to prevent the endpoint being used as a generic
// image-fetch proxy. The 2KB length cap is paranoia: real Supabase
// public URLs are well under 500 chars.

export class RemoveBackgroundDto {
  @ApiProperty({
    description: 'Public Supabase Storage URL of the image to process.',
  })
  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  imageUrl!: string;
}
