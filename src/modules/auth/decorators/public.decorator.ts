import { SetMetadata } from '@nestjs/common';

// Marks a route or controller as exempt from JwtAuthGuard.
// The guard reads this metadata via Reflector.

export const IS_PUBLIC_KEY = 'isPublic';

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
