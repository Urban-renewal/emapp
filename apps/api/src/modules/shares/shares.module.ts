import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ContractorPortalModule } from '../contractor-portal/contractor-portal.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({
  // ContractorPortalModule exports ShareTokenService (used to mint links).
  // NotificationsModule exports NotificationsProducerService (share_revoked emit).
  imports: [AuthModule, ContractorPortalModule, NotificationsModule],
  controllers: [SharesController],
  providers: [SharesService],
})
export class SharesModule {}
