import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';

import { OwnershipsController } from './ownerships.controller';
import { OwnershipsService } from './ownerships.service';

// ProjectsModule is imported for its exported StatsCacheService — an ownership
// replace changes a project's consent denominator/numerator, so the write
// invalidates the org's stats epoch (E2 Wave-0 PERF).
@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [OwnershipsController],
  providers: [OwnershipsService],
})
export class OwnershipsModule {}
