import { Module } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module';
import { CreativeGenerationsController } from './controllers/creative-generations.controller';
import { ClearEditService } from './services/clear-edit.service';
import { CommitEditService } from './services/commit-edit.service';
import { CreativeGenerationsService } from './services/creative-generations.service';
import { DispatchEditService } from './services/dispatch-edit.service';
import { DispatchService } from './services/dispatch.service';
import { PromptAssemblerService } from './services/prompt-assembler.service';

@Module({
  imports: [ScoringModule],
  controllers: [CreativeGenerationsController],
  providers: [
    CreativeGenerationsService,
    DispatchService,
    PromptAssemblerService,
    DispatchEditService,
    CommitEditService,
    ClearEditService,
  ],
  exports: [CreativeGenerationsService],
})
export class CreativeGenerationsModule {}
