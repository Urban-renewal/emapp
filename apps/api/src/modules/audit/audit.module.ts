import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { AuditReadService } from './audit-read.service';
import { AuditController } from './audit.controller';

@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditReadService],
})
export class AuditModule {}
