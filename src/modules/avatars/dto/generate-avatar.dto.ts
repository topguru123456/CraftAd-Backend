import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

// Body for POST /brands/:brandId/avatars. The actual persona content
// is AI-generated from the brand row — the caller supplies only the
// brand id, which the path already carries; this DTO exists so we
// can validate the body shape if future input fields land (e.g.
// "regenerate with this prompt tweak").
export class GenerateAvatarDto {
  // brandId is on the URL; we keep this here only as documentation
  // of the resource scope. The controller doesn't read it off the
  // body — it uses the path param.
  @ApiProperty({ format: 'uuid', required: false })
  @IsUUID()
  brandId?: string;
}
