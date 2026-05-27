import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Per-request log line, structured and minimal.
 *
 * Format: `GET /health 200 4ms` — method, path, status, duration.
 * Health-checks are noisy in Cloud Run logs (Cloud Run pings /health
 * every few seconds when serving), so they log at debug level only.
 * Everything else at info.
 *
 * No body logging — bodies can contain user content and would balloon
 * log volume. Add structured request-id later if cross-service tracing
 * becomes a need.
 *
 * URL sanitization: webhook callbacks from the GCF dispatcher present
 * the shared secret as `?token=<WEBHOOK_SECRET>` (the URL is what we
 * handed the GCF at dispatch time; we don't control it from the
 * receiving side). Without sanitization, every webhook hit writes the
 * secret to stdout — anyone with log access has full webhook auth.
 * The redact list is conservative: known auth-bearing keys plus a few
 * common variants. Stay narrow rather than allowlist params; adding a
 * new sensitive param shouldn't require a code change here, but the
 * cost of a leak is worth the small maintenance.
 */
const REDACTED_QUERY_KEYS = new Set([
  'token',
  'api_key',
  'apikey',
  'access_token',
  'auth',
  'secret',
]);

/* Strip sensitive query params from the URL string used for logging.
 * Operates on the literal string (not URL parsing) because relative
 * paths like `/webhooks/creative?token=abc` aren't WHATWG-parseable
 * without a base. Falls back to the original URL on any parsing
 * weirdness so a malformed query doesn't suppress the log entirely. */
function sanitizeUrlForLog(originalUrl: string): string {
  const qIdx = originalUrl.indexOf('?');
  if (qIdx === -1) return originalUrl;
  const path = originalUrl.slice(0, qIdx);
  const query = originalUrl.slice(qIdx + 1);
  const sanitized = query
    .split('&')
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      const key = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
      if (REDACTED_QUERY_KEYS.has(key.toLowerCase())) {
        return `${key}=REDACTED`;
      }
      return pair;
    })
    .join('&');
  return sanitized ? `${path}?${sanitized}` : path;
}

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const url = sanitizeUrlForLog(req.originalUrl);
      const line = `${req.method} ${url} ${res.statusCode} ${durationMs.toFixed(1)}ms`;
      if (req.originalUrl.startsWith('/health')) {
        this.logger.debug(line);
      } else {
        this.logger.log(line);
      }
    });
    next();
  }
}
