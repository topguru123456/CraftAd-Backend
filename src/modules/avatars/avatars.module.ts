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
})
export class AvatarsModule {}
