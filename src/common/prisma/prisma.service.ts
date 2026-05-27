import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient as a NestJS-managed singleton.
 *
 * Lifecycle:
 *   - onModuleInit  → explicit $connect. We could rely on Prisma's
 *     lazy connect on first query, but failing fast at boot is more
 *     valuable than a confusing "first request fails" later. A bad
 *     DATABASE_URL or unreachable DB surfaces here, not 3 layers
 *     deep in a handler.
 *   - onModuleDestroy → $disconnect so dev hot-reload + graceful
 *     shutdown release the pool cleanly.
 *
 * Why extend PrismaClient instead of providing it as a value:
 *   - Hooks naturally into Nest's DI lifecycle (OnModuleInit etc.).
 *   - One place to add cross-cutting concerns later (query logging,
 *     middleware, soft-delete extension) without retrofitting callers.
 *
 * Logging:
 *   - We pass a `log` config so query/info/warn events are visible in
 *     dev. In production we trim to errors only — query logs are too
 *     noisy and can leak SQL fragments into log aggregators.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'production'
          ? ['error']
          : ['error', 'warn'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
