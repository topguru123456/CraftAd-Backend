import { Module } from '@nestjs/common';
import { ProductImageGenerationsController } from './controllers/product-image-generations.controller';
import { ProductImageDispatchService } from './services/product-image-dispatch.service';
import { ProductImagePromptService } from './services/product-image-prompt.service';

@Module({
  controllers: [ProductImageGenerationsController],
  providers: [ProductImageDispatchService, ProductImagePromptService],
})
export class ProductImageGenerationsModule {}
