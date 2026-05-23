/**
 * Queue module — Phase 6 S8.
 *
 * Provides the `JOB_PRODUCER` token (resolved to `IJobProducer`).
 * Production wires `PgBossJobProducer`. Tests inject a Fake via the
 * standard NestJS overrideProvider — same pattern as STORAGE_PROVIDER.
 *
 * `@Global()` so any module can inject without re-importing.
 */
import { Global, Module } from '@nestjs/common';

import { PgBossJobProducer } from './pg-boss-producer';

/** DI token for the job producer abstraction (IJobProducer).
 *  Constants are strings (not symbols) so they survive across module
 *  graph boundaries — matches the STORAGE_PROVIDER convention. */
export const JOB_PRODUCER = 'JOB_PRODUCER' as const;

@Global()
@Module({
  providers: [
    {
      provide: JOB_PRODUCER,
      useClass: PgBossJobProducer,
    },
  ],
  exports: [JOB_PRODUCER],
})
export class QueueModule {}
