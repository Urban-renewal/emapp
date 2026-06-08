import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { OrgSettingsController } from './org-settings.controller';
import { OrgSettingsService } from './org-settings.service';

/**
 * P6-1 — Org administration module. Home of the per-org settings read/write
 * surface (`/api/v1/org/settings`), the admin-facing config for the
 * `organizations.settings` seam. AuthModule supplies the AuthGuard/TenantGuard
 * the controller composes.
 */
@Module({
  imports: [AuthModule],
  controllers: [OrgSettingsController],
  providers: [OrgSettingsService],
})
export class OrgModule {}
