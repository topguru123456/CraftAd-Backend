import { Global, Module } from '@nestjs/common';
import { GcfImagePrepService } from './gcf-image-prep.service';
import { GcfRateLimitRetryService } from './gcf-rate-limit-retry.service';
import { GcfRedispatchService } from './gcf-redispatch.service';

@Global()
@Module({
  providers: [GcfImagePrepService, GcfRedispatchService, GcfRateLimitRetryService],
  exports: [GcfImagePrepService, GcfRedispatchService, GcfRateLimitRetryService],
})
export class GcfImagePrepModule {}
