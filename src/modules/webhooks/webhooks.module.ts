import { Module } from '@nestjs/common';
import { ScoringModule } from '../scoring/scoring.module';
import { WatermarkModule } from '../watermark/watermark.module';
import { CreativeWebhookController } from './controllers/creative-webhook.controller';
import { WebhookSecretGuard } from './guards/webhook-secret.guard';
import { CreativeEditWebhookService } from './services/creative-edit-webhook.service';
import { CreativeWebhookService } from './services/creative-webhook.service';

@Module({
  imports: [ScoringModule, WatermarkModule],
  controllers: [CreativeWebhookController],
  providers: [CreativeWebhookService, CreativeEditWebhookService, WebhookSecretGuard],
})
export class WebhooksModule {}
