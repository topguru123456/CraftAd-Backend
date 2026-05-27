import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './controllers/auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

// Registers JwtAuthGuard as the app-wide guard. Routes opt out with @Public().

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    JwtAuthGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
