import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({
  imports: [AuthModule],
  controllers: [SharesController],
  providers: [SharesService],
})
export class SharesModule {}
