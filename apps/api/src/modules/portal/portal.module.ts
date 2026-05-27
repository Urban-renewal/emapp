import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';

/**
 * V11 B.S4 — Tenant Portal (D.40).
 *
 * Imports AuthModule for the shared JwtModule used by TenantAuthGuard.
 * No write endpoints in V11; PortalService is the only provider.
 */
@Module({
  imports: [AuthModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
