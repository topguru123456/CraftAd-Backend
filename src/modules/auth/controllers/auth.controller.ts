import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AuthenticatedUser } from '../types/authenticated-user.type';

// /auth/whoami — returns the verified JWT identity + metadata.
// No DB hit; the JWT already carries everything (id, email, onboarding,
// stripe_customer_id, avatar, etc. from auth.users.raw_user_meta_data).

@ApiTags('auth')
@ApiBearerAuth('supabase-jwt')
@Controller('auth')
export class AuthController {
  @Get('whoami')
  @ApiOkResponse({ description: 'The authenticated user, parsed from the JWT.' })
  whoami(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
