import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ParkedOutboundController } from './parked-outbound.controller';
import { ParkedOutboundService } from './parked-outbound.service';

/**
 * PARKED-OUTBOUND ops module (Autonomous Master Plan — the #509 observability
 * gap). A manager-facing read + resolve over the EXISTING `outbound_ledger`
 * table — MIGRATION-FREE (no new table, reads/updates the existing rows).
 *
 * Surfaces the outbound rows stuck `pending_send` (ambiguous maybe-sent +
 * stale never-settled claims) that the merged reminder-cadence spine NEVER
 * auto-resends (correct for M1 exactly-once) but which are otherwise invisible.
 * AuthModule provides the org auth guards; the service is manager-only + RLS.
 */
@Module({
  imports: [AuthModule],
  controllers: [ParkedOutboundController],
  providers: [ParkedOutboundService],
  exports: [ParkedOutboundService],
})
export class ParkedOutboundModule {}
