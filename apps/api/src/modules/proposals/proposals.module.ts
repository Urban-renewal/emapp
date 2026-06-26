import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SignaturesModule } from '../signatures/signatures.module';

import { ProposalsController } from './proposals.controller';
import { ProposalsService } from './proposals.service';

/**
 * Approval-Inbox module (Autonomous Master Plan, Phase 1) — the BE read +
 * approve/reject over the `proposals` table.
 *
 * Imports SignaturesModule to reuse `SignatureRequestsService.reissueAndDeliver` +
 * `sendGovernedReminder` VERBATIM as the OUTBOUND executors. The internal
 * `task.create` effect is the DI-free `applyProposalEffect` (`@emapp/db`, wave 1.2),
 * shared with the producer's auto-execute — so TasksModule is no longer needed here.
 * AuthModule provides the org auth guards.
 */
@Module({
  imports: [AuthModule, SignaturesModule],
  controllers: [ProposalsController],
  providers: [ProposalsService],
  exports: [ProposalsService],
})
export class ProposalsModule {}
