import { Module } from '@nestjs/common';
import { BrandsController } from './controllers/brands.controller';
import { BrandFetchService } from './services/brand-fetch.service';
import { BrandsService } from './services/brands.service';

@Module({
  controllers: [BrandsController],
  providers: [BrandsService, BrandFetchService],
})
export class BrandsModule {}
