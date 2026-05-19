import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { AcceptInviteController } from './accept-invite.controller';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

// AuthModule exports JwtModule (invite-token sign/verify) + the guards.
@Module({
  imports: [AuthModule],
  controllers: [MembersController, AcceptInviteController],
  providers: [MembersService],
})
export class MembersModule {}
