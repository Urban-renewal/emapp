import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Imports module — Phase 6 (docs/03 §10).
 *
 * S2 scope: GET status + SSE progress stream. The worker (apps/worker/)
 * is the consume side; this module is read-only for S2. POST/cancel/
 * errors-export land in S8 once the worker pipeline is complete.
 */
@Module({
  imports: [AuthModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
