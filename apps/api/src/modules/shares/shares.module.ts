import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ContractorPortalModule } from '../contractor-portal/contractor-portal.module';

import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({
  // ContractorPortalModule exports ShareTokenService (used to mint links).
  imports: [AuthModule, ContractorPortalModule],
  controllers: [SharesController],
  providers: [SharesService],
})
export class SharesModule {}
