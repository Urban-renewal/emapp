import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SignaturesModule } from '../signatures/signatures.module';
import { TasksModule } from '../tasks/tasks.module';

import { ProposalsController } from './proposals.controller';
import { ProposalsService } from './proposals.service';

/**
 * Approval-Inbox module (Autonomous Master Plan, Phase 1) — the BE read +
 * approve/reject over the `proposals` table.
 *
 * Imports SignaturesModule to reuse `SignatureRequestsService.reissueExpired` +
 * `sendGovernedReminder` VERBATIM, and TasksModule to reuse `TasksService.create`
 * VERBATIM as the G1 `task.create` executor — the EXISTING gated paths, so a
 * proposal can never do something a human couldn't do through the normal UI.
 * AuthModule provides the org auth guards.
 */
@Module({
  imports: [AuthModule, SignaturesModule, TasksModule],
  controllers: [ProposalsController],
  providers: [ProposalsService],
  exports: [ProposalsService],
})
export class ProposalsModule {}
