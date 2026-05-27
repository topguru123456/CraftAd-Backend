import { Module } from '@nestjs/common';
import { WatermarkService } from './services/watermark.service';

// Exports WatermarkService so the webhook + commit-edit modules can inject
// it without re-loading the asset per consumer. One process-wide instance
// holds the cached logo Buffer.

@Module({
  providers: [WatermarkService],
  exports: [WatermarkService],
})
export class WatermarkModule {}
