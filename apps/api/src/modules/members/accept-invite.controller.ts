import { AcceptInviteInput, type AcceptInvite } from '@emapp/shared-types';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

import { MembersService } from './members.service';

// PUBLIC (no AuthGuard / no AuthzResource): an invited user has no
// session yet. They present the one-time invite token and set their OWN
// password. Generic `invalid_invite` on any failure (no oracle).
// Rate-limited at the global throttler (100/min/IP).
@Controller('auth')
export class AcceptInviteController {
  constructor(private readonly members: MembersService) {}

  @Post('accept-invite')
  @HttpCode(200)
  async accept(@Body(new ZodValidationPipe(AcceptInviteInput)) body: AcceptInvite) {
    await this.members.acceptInvite(body);
    return { data: { ok: true } };
  }
}
