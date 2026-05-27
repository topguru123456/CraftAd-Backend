import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/* Body for POST /scoring/score-creative.
 *
 * The uploaded image is shipped inline as a `data:image/...;base64,...` URL.
 * No bucket, no DB row — the score is returned synchronously and forgotten.
 * The 20MB JSON body cap in main.ts (already in place for webhook payloads)
 * is the practical upper bound; we cap the string length here so a malformed
 * mega-payload is rejected before the validator parses it.
 *
 * MAX_LENGTH = ~15MB of base64 (≈ 11MB of raw image bytes) — comfortably
 * within the body parser limit, well above any reasonable ad creative
 * (PNGs are typically <2MB; high-res photo JPEGs ~5MB). */
const MAX_DATA_URL_LENGTH = 15_000_000;

export class ScoreCreativeDto {
  @ApiProperty({
    description:
      'Image as a data URL: `data:image/<png|jpeg|webp>;base64,<...>`. Cap ~15MB.',
    example: 'data:image/png;base64,iVBORw0KGgo...',
  })
  @IsString()
  @MaxLength(MAX_DATA_URL_LENGTH, {
    message: 'imageDataUrl exceeds the 15MB upload cap',
  })
  @Matches(/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/, {
    message: 'imageDataUrl must be a base64 data URL for PNG, JPEG, or WebP',
  })
  imageDataUrl!: string;
}
