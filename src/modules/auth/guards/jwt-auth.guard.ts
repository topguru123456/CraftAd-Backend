import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import * as jose from 'jose';
import { AppConfigService } from '../../../config/config.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  AppMetadata,
  AuthenticatedUser,
  UserMetadata,
} from '../types/authenticated-user.type';

// Supabase JWT claims we read.
interface SupabaseJwtPayload extends jose.JWTPayload {
  sub?: string;
  email?: string;
  role?: string;
  user_metadata?: UserMetadata;
  app_metadata?: AppMetadata;
}

// Global guard. Verifies Supabase JWTs via the project's JWKS endpoint
// (asymmetric ES256/RS256 — the default on new Supabase projects).
// `jose` caches keys and refetches on rotation; the first request after
// boot pays one HTTP fetch, the rest hit cache.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly jwks: ReturnType<typeof jose.createRemoteJWKSet>;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
  ) {
    const supabaseUrl = this.config.require('SUPABASE_URL');
    this.jwks = jose.createRemoteJWKSet(
      new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`),
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);

    let payload: SupabaseJwtPayload;
    try {
      const result = await jose.jwtVerify(token, this.jwks);
      payload = result.payload as SupabaseJwtPayload;
    } catch (err) {
      if (err instanceof jose.errors.JWTExpired) {
        // Distinct message so FE can refresh silently instead of logout.
        throw new UnauthorizedException('Token expired');
      }
      this.logger.warn(
        `JWT verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('Invalid token');
    }

    if (!payload.sub) {
      throw new UnauthorizedException('Token missing sub claim');
    }
    if (payload.role !== 'authenticated') {
      throw new UnauthorizedException('Token role is not authorized');
    }

    const user: AuthenticatedUser = {
      id: payload.sub,
      email: payload.email,
      metadata: payload.user_metadata ?? {},
      appMetadata: payload.app_metadata ?? {},
    };
    (request as Request & { user: AuthenticatedUser }).user = user;
    return true;
  }

  private extractBearerToken(request: Request): string {
    const header = request.headers.authorization;
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing Authorization header');
    }
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException(
        'Authorization header must be "Bearer <token>"',
      );
    }
    return token;
  }
}
