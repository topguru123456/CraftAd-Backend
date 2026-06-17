import { Module } from '@nestjs/common';
import { GenerationReaperService } from './generation-reaper.service';

/* Holds the GenerationReaperService cron worker.
 * PrismaService is @Global so no explicit import is needed here. */
@Module({
  providers: [GenerationReaperService],
})
export class ReaperModule {}
