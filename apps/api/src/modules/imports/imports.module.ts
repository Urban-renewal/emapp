import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { STORAGE_PROVIDER, storageProviderFactory } from '../documents/storage';

import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Imports module — Phase 6 (docs/03 §10).
 *
 * S2 ships GET status + SSE progress stream.
 * S8 (this update) adds POST + start + cancel + errors + D.34 mapping
 * wizard. The mutation endpoints need:
 *   - STORAGE_PROVIDER (presigned PUT URLs, head() for upload check)
 *   - JOB_PRODUCER     (enqueue pg-boss; provided by global QueueModule)
 *
 * STORAGE_PROVIDER is re-bound here (mirroring documents.module) so a
 * test can `overrideProvider(STORAGE_PROVIDER)` without dragging
 * DocumentsModule into the testing graph. The factory itself FAILS
 * FAST in production until R2 is wired (Gate-5 / D.28).
 */
@Module({
  imports: [AuthModule],
  controllers: [ImportsController],
  providers: [
    ImportsService,
    {
      provide: STORAGE_PROVIDER,
      useFactory: storageProviderFactory,
    },
  ],
})
export class ImportsModule {}
