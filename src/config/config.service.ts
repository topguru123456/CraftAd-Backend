import { Injectable } from '@nestjs/common';
import { Env } from './env.schema';

/**
 * Typed wrapper around the validated Env.
 *
 * Inject this service anywhere you'd otherwise reach for `process.env`:
 *
 *   constructor(private readonly config: AppConfigService) {}
 *   this.config.get('OPENAI_API_KEY')   // typed string | undefined
 *
 * The contract: every key is the result of `envSchema.parse` — already
 * coerced, validated, and shaped. No string-to-number, no manual
 * defaults inside consumers.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly env: Env) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  /**
   * Convenience for the common "this endpoint requires X" pattern.
   * Throws with a clear message if the optional key isn't set, so a
   * misconfigured deploy surfaces the missing secret name at the
   * boundary rather than as a generic 500.
   */
  require<K extends keyof Env>(key: K): NonNullable<Env[K]> {
    const value = this.env[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `Required env var "${String(key)}" is not set. ` +
          `Set it in Cloud Run secret manager (prod) or backend/.env (dev).`,
      );
    }
    return value as NonNullable<Env[K]>;
  }

  get isProd(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
