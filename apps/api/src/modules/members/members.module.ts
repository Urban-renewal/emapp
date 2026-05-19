import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { AcceptInviteController } from './accept-invite.controller';
import { EMAIL_PROVIDER, emailProviderFactory } from './invite-email';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

// AuthModule exports JwtModule (invite-token sign/verify) + the guards.
// EMAIL_PROVIDER: D.27 — invite delivery via IEmailProvider (Fake until
// Resend is an Infisical swap; same governed pattern as NoopSMSProvider).
@Module({
  imports: [AuthModule],
  controllers: [MembersController, AcceptInviteController],
  providers: [MembersService, { provide: EMAIL_PROVIDER, useFactory: emailProviderFactory }],
})
export class MembersModule {}
