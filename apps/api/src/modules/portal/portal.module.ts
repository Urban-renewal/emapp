import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SignaturesModule } from '../signatures/signatures.module';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

/**
 * V11 B.S4 — Tenant Portal (D.40).
 *
 * Imports AuthModule (shared JwtModule for TenantAuthGuard) + SignaturesModule
 * (B-RESIDENT-1 — the resident self-resend reuses SignatureRequestsService).
 */
@Module({
  imports: [AuthModule, SignaturesModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
