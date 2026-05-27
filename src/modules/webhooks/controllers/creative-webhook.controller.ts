import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { CreativeEditWebhookDto } from '../dto/creative-edit-webhook.dto';
import { CreativeWebhookDto } from '../dto/creative-webhook.dto';
import { WebhookSecretGuard } from '../guards/webhook-secret.guard';
import { CreativeEditWebhookService } from '../services/creative-edit-webhook.service';
import {
  CreativeWebhookService,
  WebhookOutcome,
} from '../services/creative-webhook.service';

// Public route (no JWT) — auth is via the WebhookSecretGuard which
// constant-time compares the ?token= against WEBHOOK_SECRET. @Public()
// makes the global JwtAuthGuard skip; the @UseGuards line below adds
// the secret check explicitly.

@ApiTags('webhooks')
@Controller('webhooks')
export class CreativeWebhookController {
  constructor(
    private readonly service: CreativeWebhookService,
    private readonly editService: CreativeEditWebhookService,
  ) {}

  @Post('creative')
  @Public()
  @UseGuards(WebhookSecretGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'GCF callback for generated variants. Always 200 (idempotent).',
  })
  @ApiOkResponse({
    description:
      'Outcome envelope. `reason` distinguishes unknown_uid / already_terminal / worker_error / upload_failed / missing_image / bad_base64 from the success path.',
  })
  handle(@Body() body: CreativeWebhookDto): Promise<WebhookOutcome> {
    return this.service.handle(body);
  }

  @Post('creative-edit')
  @Public()
  @UseGuards(WebhookSecretGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'GCF callback for edit candidates. Writes to edit_* columns only.',
  })
  @ApiOkResponse({ description: 'Same envelope shape as /webhooks/creative.' })
  handleEdit(@Body() body: CreativeEditWebhookDto): Promise<WebhookOutcome> {
    return this.editService.handle(body);
  }
}
