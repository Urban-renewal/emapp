import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

// P2 Phase 1 — custom permission groups (org-defined roles) + assign/revoke.
// AuthModule provides AuthGuard/TenantGuard (the controller's @UseGuards chain).
// The AuthorizationGuard + PermissionService are zero-DI (instantiated in place),
// matching the members/projects modules.
@Module({
  imports: [AuthModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
