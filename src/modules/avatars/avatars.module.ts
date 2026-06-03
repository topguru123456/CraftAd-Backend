import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SupabaseStorageModule } from '../../common/storage/supabase-storage.module';
import { AvatarsController } from './controllers/avatars.controller';
import { AvatarsService } from './services/avatars.service';
import { GeminiPortraitService } from './services/gemini-portrait.service';
import { OpenAiAvatarService } from './services/openai-avatar.service';

@Module({
  imports: [PrismaModule, SupabaseStorageModule],
  controllers: [AvatarsController],
  providers: [AvatarsService, OpenAiAvatarService, GeminiPortraitService],
  // Exported so BrandsModule can fire-and-forget an avatar generation
  // when a new brand is created. The service-level call bypasses the
  // controller-level @PlanLimit guard, which is fine here because the
  // auto-trigger isn't a user-initiated action — the brand quota is
  // already consumed at this point and the avatar is bonus output.
  exports: [AvatarsService],
})
export class AvatarsModule {}
