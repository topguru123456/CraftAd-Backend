import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ScoreCreativeDto } from '../dto/score-creative.dto';
import { ScoreResult, ScoringService } from '../services/scoring.service';

/* User-facing scoring endpoint backing /app/creative-score.
 *
 * Ephemeral by design: the image is shipped inline as a data URL, sent to
 * GPT-4o vision, and the parsed scores are returned in the same response.
 * Nothing is persisted. The handoff §12.11 `creative_scores` history table
 * is intentionally NOT wired here — the product decision is "score now,
 * forget", so we don't carry that schema yet.
 *
 * The auto-scoring path for campaign-creative variants is a separate flow
 * (ScoringService.score) that runs fire-and-forget after the webhook lands.
 * Both share the OpenAI call inside ScoringService. */
@ApiTags('scoring')
@ApiBearerAuth('supabase-jwt')
@Controller('scoring')
export class ScoringController {
  private readonly logger = new Logger(ScoringController.name);

  constructor(private readonly scoring: ScoringService) {}

  @Post('score-creative')
  @ApiOperation({
    summary:
      'Score an uploaded ad creative with GPT-4o vision (no persistence)',
  })
  @ApiOkResponse({
    description: 'Creative + performance scores plus 4 improvement tips.',
  })
  async scoreCreative(@Body() dto: ScoreCreativeDto): Promise<ScoreResult> {
    try {
      return await this.scoring.scoreImageUrl(dto.imageDataUrl);
    } catch (err) {
      // ScoringService.scoreImageUrl throws Error('scoring_failed:<reason>')
      // for any non-success path (openai timeout, refusal, unparseable JSON,
      // etc). Surface as 502 so the FE can show a generic retry CTA without
      // leaking which underlying step blew up.
      const reason =
        err instanceof Error ? err.message : 'scoring_failed:unknown';
      this.logger.warn(`score-creative ${reason}`);
      throw new HttpException(
        { error: 'scoring_failed', reason },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
