import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

// AuthModule exports AuthGuard, TenantGuard and JwtModule — the controller
// reuses them (no auth logic re-implemented here).
@Module({
  imports: [AuthModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
