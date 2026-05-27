import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../../../config/config.service';

// Validates the shared-secret token GCF presents on webhook callbacks.
// Accepted in either the ?token= query (preferred — what we encode into
// webhook_url) or the x-craftad-webhook-secret header (fallback in case
// the dispatcher's retry path drops query params).
//
// Constant-time comparison so an attacker can't time-leak the secret one
// byte at a time. Mismatched lengths short-circuit to false but reveal
// length to a determined attacker — acceptable for a 32-byte secret.

@Injectable()
export class WebhookSecretGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const presented = this.extractToken(request);
    const expected = this.config.require('WEBHOOK_SECRET');

    if (!this.constantTimeEqual(presented, expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractToken(request: Request): string {
    const queryToken = request.query['token'];
    if (typeof queryToken === 'string' && queryToken) return queryToken;
    const headerToken = request.headers['x-craftad-webhook-secret'];
    if (typeof headerToken === 'string' && headerToken) return headerToken;
    return '';
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}
