import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';

import { AuthService } from './auth.service';
import type { AccessTokenPayload } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthGuard } from './guards/auth.guard';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  async getMe(@CurrentUser() user: AccessTokenPayload) {
    const profile = await this.authService.getMe(user.sub);
    if (!profile) {
      throw new NotFoundException({ error: { code: 'user_not_found' } });
    }
    return { data: profile };
  }
}
