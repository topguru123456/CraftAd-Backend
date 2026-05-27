import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { GcfImagePrepModule } from './common/gcf/gcf-image-prep.module';
import { SupabaseStorageModule } from './common/storage/supabase-storage.module';
import { RequestLoggerMiddleware } from './common/logger/request-logger.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { AvatarsModule } from './modules/avatars/avatars.module';
import { BillingModule } from './modules/billing/billing.module';
import { BrandsModule } from './modules/brands/brands.module';
import { CopywritingGenerationsModule } from './modules/copywriting-generations/copywriting-generations.module';
import { CreativeGenerationsModule } from './modules/creative-generations/creative-generations.module';
import { DownloadsModule } from './modules/downloads/downloads.module';
import { ProductImageGenerationsModule } from './modules/product-image-generations/product-image-generations.module';
import { VideoGenerationsModule } from './modules/video-generations/video-generations.module';
import { HealthModule } from './modules/health/health.module';
import { ImagesModule } from './modules/images/images.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { QuotaModule } from './modules/quota/quota.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { WatermarkModule } from './modules/watermark/watermark.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

// ConfigModule, PrismaModule, AuthModule are @Global so feature modules
// don't re-import them. Request logger applies to every route.

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    SupabaseStorageModule,
    GcfImagePrepModule,
    AuthModule,
    HealthModule,
    BrandsModule,
    AvatarsModule,
    BillingModule,
    QuotaModule,
    ProjectsModule,
    CreativeGenerationsModule,
    CopywritingGenerationsModule,
    ProductImageGenerationsModule,
    VideoGenerationsModule,
    ScoringModule,
    WatermarkModule,
    WebhooksModule,
    DownloadsModule,
    ImagesModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
