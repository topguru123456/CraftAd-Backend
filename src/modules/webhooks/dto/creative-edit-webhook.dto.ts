import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

// Same shape as CreativeWebhookDto — GCF edit worker uses the same
// envelope as the generate worker. Different controller because the
// row-side behavior differs (writes edit_* columns, doesn't fire scoring).

export class CreativeEditWebhookDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  uid!: string;

  @ApiProperty({ enum: ['success', 'error'] })
  @IsIn(['success', 'error'])
  status!: 'success' | 'error';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image_base64?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provider?: string;
}
