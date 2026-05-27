// dotenv must run before any process.env read (loadEnv runs inside
// ConfigModule's factory). No-op in prod where env comes from Cloud Run.
import 'dotenv/config';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AppConfigService } from './config/config.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    /* Use the default Nest logger; LOG_LEVEL is applied below. */
    bufferLogs: true,
    /* rawBody=true keeps a copy of the un-parsed request bytes on
     * `req.rawBody` alongside the parsed JSON body. The Stripe webhook
     * (POST /billing/webhook) needs the EXACT byte sequence Stripe signed
     * — JSON parse+stringify reorders keys and drops whitespace, which
     * breaks the HMAC. The webhook controller accesses it via @RawBody(). */
    rawBody: true,
  });

  const config = app.get(AppConfigService);

  const level = config.get('LOG_LEVEL');
  app.useLogger(
    level === 'debug' || level === 'verbose'
      ? ['log', 'error', 'warn', 'debug', 'verbose']
      : ['log', 'error', 'warn'],
  );

  // Explicit allowlist (JWT auth — no cookies). Include ngrok header so
  // browser calls through ngrok-free.dev reach Nest instead of the HTML
  // interstitial (which returns 200 without CORS headers).
  app.enableCors({
    origin: config.get('CORS_ORIGINS'),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'ngrok-skip-browser-warning',
    ],
  });

  // Webhook payloads carry base64-encoded images (1024² PNG ≈ 1-3MB,
  // base64 adds 33%). 20MB is generous enough for any reasonable
  // resolution without inviting truly oversized uploads.
  //
  // rawBody: true is set on NestFactory.create above, but we explicitly
  // pass it here too. Nest's useBodyParser CAN preserve the raw-body
  // capture when called after rawBody: true, but the behavior depends on
  // version internals (isMiddlewareApplied check). Passing the flag
  // explicitly is the documented belt-and-suspenders pattern and makes
  // the contract obvious to a future reader: "this parser populates BOTH
  // req.body AND req.rawBody." The Stripe webhook controller depends on
  // req.rawBody via @RawBody() to verify the signature.
  app.useBodyParser('json', { limit: '20mb', rawBody: true });

  /* Tranzila's classic iframe POSTs the notify callback as
   * application/x-www-form-urlencoded (docs/billing-tranzila.md §4.3).
   * Notify bodies are small (~1-2KB) — 32KB is generous. extended:false
   * forces the query-string library parser, which is sufficient for
   * Tranzila's flat key=value bodies and rejects nested object syntax. */
  app.useBodyParser('urlencoded', { limit: '32kb', extended: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: config.isProd,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger at /api/docs; spec JSON at /api/docs-json for typed FE clients.
  const swagger = new DocumentBuilder()
    .setTitle('Craftad API')
    .setDescription('Backend API for the Craftad app.')
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'supabase-jwt',
    )
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swagger),
    { jsonDocumentUrl: 'api/docs-json' },
  );

  const port = config.get('PORT');
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Craftad API listening on http://localhost:${port}`);
  logger.log(`Swagger UI at  http://localhost:${port}/api/docs`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
