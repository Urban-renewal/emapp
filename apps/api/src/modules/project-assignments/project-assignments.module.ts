import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ProjectAssignmentsController } from './project-assignments.controller';
import { ProjectAssignmentsService } from './project-assignments.service';

@Module({
  imports: [AuthModule],
  controllers: [ProjectAssignmentsController],
  providers: [ProjectAssignmentsService],
})
export class ProjectAssignmentsModule {}
