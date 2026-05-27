import { PartialType } from '@nestjs/swagger';
import { CreateBrandDto } from './create-brand.dto';

// Same fields as create, all optional. PartialType carries validators
// over so a present field is still validated.
export class UpdateBrandDto extends PartialType(CreateBrandDto) {}
