import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { OrgStatsController } from './org-stats.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

// AuthModule exports AuthGuard, TenantGuard and JwtModule — the controllers
// reuse them (no auth logic re-implemented here).
@Module({
  imports: [AuthModule],
  controllers: [ProjectsController, OrgStatsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
