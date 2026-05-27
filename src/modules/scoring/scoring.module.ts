import { Module } from '@nestjs/common';
import { ScoringController } from './controllers/scoring.controller';
import { ScoringService } from './services/scoring.service';

// Exports ScoringService so the webhook module (and 2.3's commit-edit
// service) can inject it without re-wiring OpenAI client configuration.
// ScoringController exposes the user-facing /scoring/score-creative
// endpoint backing the /app/creative-score upload flow.

@Module({
  controllers: [ScoringController],
  providers: [ScoringService],
  exports: [ScoringService],
})
export class ScoringModule {}
