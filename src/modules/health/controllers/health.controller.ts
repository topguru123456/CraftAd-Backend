import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';

// Liveness probe for Cloud Run. @Public so it doesn't require a JWT.

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  private readonly bootedAt = Date.now();

  @Get()
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        uptimeSec: { type: 'number', example: 42.1 },
        version: { type: 'string', example: '0.1.0' },
      },
    },
  })
  check(): { status: string; uptimeSec: number; version: string } {
    return {
      status: 'ok',
      uptimeSec: Number(((Date.now() - this.bootedAt) / 1000).toFixed(1)),
      version: process.env.npm_package_version ?? '0.0.0',
    };
  }
}
