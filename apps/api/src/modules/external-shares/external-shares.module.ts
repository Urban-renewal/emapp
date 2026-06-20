import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ExternalSharesController } from './external-shares.controller';
import { ExternalSharesService } from './external-shares.service';

// X-S3 (V13) — external_share foundation module. Manager-only grant management
// (create/update/revoke/extend/resend/list) over the party-typed external_share
// table. AuthModule provides the org auth guards (AuthGuard/TenantGuard).
@Module({
  imports: [AuthModule],
  controllers: [ExternalSharesController],
  providers: [ExternalSharesService],
  exports: [ExternalSharesService],
})
export class ExternalSharesModule {}
