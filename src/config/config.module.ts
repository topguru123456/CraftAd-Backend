import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './config.service';
import { loadEnv } from './env.schema';

/**
 * Global config module — exports a typed AppConfigService usable
 * everywhere without re-importing this module.
 *
 * loadEnv() runs ONCE at module-construction time (= app bootstrap).
 * If anything is missing or malformed the app fails fast before
 * accepting any requests.
 */
@Global()
@Module({
  providers: [
    {
      provide: AppConfigService,
      useFactory: () => new AppConfigService(loadEnv()),
    },
  ],
  exports: [AppConfigService],
})
export class ConfigModule {}
