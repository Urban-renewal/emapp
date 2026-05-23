/**
 * pg-boss producer adapter — Phase 6 S8.
 *
 * The single file in apps/api that knows pg-boss types. Every other
 * file talks to `IJobProducer` from @emapp/jobs. Mirror of the
 * apps/worker/src/pg-boss-adapter.ts file on the consume side.
 *
 * Lifecycle:
 *   - Connects on first send (lazy) so unit tests that never enqueue
 *     don't open a DB connection.
 *   - Shares the worker's PG_BOSS_SCHEMA so consumed + produced jobs
 *     land in the same queue tables.
 *   - On graceful shutdown (Nest's `onModuleDestroy` lifecycle hook
 *     wired in QueueModule), calls boss.stop({graceful:true}) — but
 *     short timeout (the API process doesn't OWN the queue, the
 *     worker does; we just need to flush any in-flight sends).
 *
 * Security:
 *   - Uses PROVIDER_DATABASE_URL (BYPASSRLS). pg-boss's schema is
 *     queue plumbing, not customer data — RLS doesn't apply.
 *   - Payload is opaque to this adapter. Callers MUST Zod-validate
 *     before sending (the IJobProducer interface contract — see
 *     packages/jobs/src/producer.ts).
 */
import { env } from '@emapp/db';
import type { IJobProducer, JobSendOptions, JobSendResult } from '@emapp/jobs';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import PgBoss from 'pg-boss';

/** Same schema as the worker — keeps consumed + produced jobs in one
 *  place. MUST match `PG_BOSS_SCHEMA` in apps/worker/src/main.ts. */
const PG_BOSS_SCHEMA = 'pgboss' as const;

@Injectable()
export class PgBossJobProducer implements IJobProducer, OnModuleDestroy {
  private readonly logger = new Logger(PgBossJobProducer.name);
  private boss: PgBoss | null = null;
  private startPromise: Promise<PgBoss> | null = null;

  /** Lazy connection. First send() triggers `boss.start()`; subsequent
   *  sends reuse the same instance. We DON'T start in onModuleInit
   *  because (a) unit tests inject a Fake, (b) the migrate-on-start
   *  is best done by the worker (single ownership). */
  private async getBoss(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const boss = new PgBoss({
        connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
        schema: PG_BOSS_SCHEMA,
        // The API is producer-only; we don't need pg-boss to apply
        // its migrate-on-start (the worker is the owner of schema
        // mutation). But pg-boss requires start() before send().
      });
      boss.on('error', (err: Error): void => {
        this.logger.error(`pg-boss producer error: ${err.message}`);
      });
      await boss.start();
      this.boss = boss;
      this.logger.log('pg-boss producer connected');
      return boss;
    })();
    return this.startPromise;
  }

  async send<TPayload>(
    name: string,
    payload: TPayload,
    opts?: JobSendOptions,
  ): Promise<JobSendResult> {
    const boss = await this.getBoss();
    // pg-boss v10 `send` accepts options inline. Map our IJobProducer
    // surface to the pg-boss-specific keys. The returned id is null
    // when a singletonKey collision dedup'd this send.
    const sendOpts: Record<string, unknown> = {};
    if (opts?.singletonKey) sendOpts['singletonKey'] = opts.singletonKey;
    if (typeof opts?.retryLimit === 'number') sendOpts['retryLimit'] = opts.retryLimit;
    const id = await boss.send(name, payload as object, sendOpts);
    return { id: id ?? null };
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.boss) return;
    try {
      await this.boss.stop({ graceful: true, timeout: 5_000 });
    } catch (e) {
      this.logger.warn(
        `pg-boss producer stop errored: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }
}
