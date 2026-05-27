import { Global, Module } from '@nestjs/common';
import { SupabaseStorageService } from './supabase-storage.service';

// @Global so feature modules don't have to re-import — same pattern as
// PrismaModule and ConfigModule.

@Global()
@Module({
  providers: [SupabaseStorageService],
  exports: [SupabaseStorageService],
})
export class SupabaseStorageModule {}
