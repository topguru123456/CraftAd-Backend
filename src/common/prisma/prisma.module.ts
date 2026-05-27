import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global Prisma module. Feature modules don't need to re-import this
 * to inject PrismaService — same pattern as ConfigModule.
 *
 * Keeping Prisma access global means feature modules stay focused on
 * their own concerns; they don't repeat boilerplate to wire the DB.
 * The cost (a slightly looser module graph) is worth the consistency.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
