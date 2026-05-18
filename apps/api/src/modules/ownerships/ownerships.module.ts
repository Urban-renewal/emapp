import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { OwnershipsController } from './ownerships.controller';
import { OwnershipsService } from './ownerships.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnershipsController],
  providers: [OwnershipsService],
})
export class OwnershipsModule {}
