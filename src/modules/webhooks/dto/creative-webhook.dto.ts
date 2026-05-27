import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

// Payload shape per the GCF worker contract.
//   Success: { uid, image_base64, status: 'success', provider? }
//   Failure: { uid, status: 'error', message? }
//
// `image_base64` is intentionally not required at the DTO level — a
// `status='success'` payload missing it is malformed, but we want the
// service to surface that as "row marked failed with a clear message",
// not a generic 400 that GCF would retry on.

export class CreativeWebhookDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  uid!: string;

  @ApiProperty({ enum: ['success', 'error'] })
  @IsIn(['success', 'error'])
  status!: 'success' | 'error';

  @ApiPropertyOptional({
    description: 'Base64-encoded PNG (with or without data: prefix). Required on status=success.',
  })
  @IsOptional()
  @IsString()
  image_base64?: string;

  @ApiPropertyOptional({ description: 'Error message on status=error.' })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provider?: string;
}
