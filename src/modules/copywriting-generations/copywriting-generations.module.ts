import { Module } from '@nestjs/common';
import { CopywritingGenerationsController } from './controllers/copywriting-generations.controller';
import { CopywritingDispatchService } from './services/copywriting-dispatch.service';
import { CopywritingGenerationsService } from './services/copywriting-generations.service';
import { CopywritingPromptService } from './services/copywriting-prompt.service';
import { OpenAiCopywritingService } from './services/openai-copywriting.service';

@Module({
  controllers: [CopywritingGenerationsController],
  providers: [
    CopywritingGenerationsService,
    CopywritingDispatchService,
    CopywritingPromptService,
    OpenAiCopywritingService,
  ],
  exports: [CopywritingGenerationsService],
})
export class CopywritingGenerationsModule {}
