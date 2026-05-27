import { Module } from '@nestjs/common';
import { ImagesController } from './controllers/images.controller';
import { AiImageService } from './services/ai-image.service';
import { BackgroundRemovalService } from './services/background-removal.service';
import { PexelsService } from './services/pexels.service';

@Module({
  controllers: [ImagesController],
  providers: [PexelsService, AiImageService, BackgroundRemovalService],
})
export class ImagesModule {}
