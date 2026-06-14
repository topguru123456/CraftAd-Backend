import { Global, Module } from '@nestjs/common';
import { GcfImagePrepService } from './gcf-image-prep.service';
import { GcfRedispatchService } from './gcf-redispatch.service';

@Global()
@Module({
  providers: [GcfImagePrepService, GcfRedispatchService],
  exports: [GcfImagePrepService, GcfRedispatchService],
})
export class GcfImagePrepModule {}
