import { Module } from '@nestjs/common';
import { VideoGenerationsController } from './controllers/video-generations.controller';
import { VeoApiService } from './services/veo-api.service';
import { VeoPollService } from './services/veo-poll.service';
import { VideoDispatchService } from './services/video-dispatch.service';
import { VideoGenerationsService } from './services/video-generations.service';
import { VideoPromptService } from './services/video-prompt.service';

@Module({
  controllers: [VideoGenerationsController],
  providers: [
    VideoDispatchService,
    VideoGenerationsService,
    VideoPromptService,
    VeoApiService,
    VeoPollService,
  ],
  exports: [VideoGenerationsService],
})
export class VideoGenerationsModule {}
