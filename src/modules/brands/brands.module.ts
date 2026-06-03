import { Module } from '@nestjs/common';
import { AvatarsModule } from '../avatars/avatars.module';
import { BrandsController } from './controllers/brands.controller';
import { BrandFetchService } from './services/brand-fetch.service';
import { BrandsService } from './services/brands.service';

@Module({
  imports: [AvatarsModule],
  controllers: [BrandsController],
  providers: [BrandsService, BrandFetchService],
})
export class BrandsModule {}
