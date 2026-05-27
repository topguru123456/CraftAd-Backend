import { Module } from '@nestjs/common';
import { DownloadsController } from './controllers/downloads.controller';
import { DownloadsService } from './services/downloads.service';

// Provides the /downloads/* endpoints that mint signed URLs for files in
// PRIVATE storage. Today this exposes /downloads/creative/:id; future
// flows that gate downloads on quota (avatar portraits, exports, etc.)
// hang off the same controller.

@Module({
  controllers: [DownloadsController],
  providers: [DownloadsService],
})
export class DownloadsModule {}
