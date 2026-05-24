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
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import PgBoss from 'pg-boss';

/** Same schema as the worker — keeps consumed + produced jobs in one
 *  place. MUST match `PG_BOSS_SCHEMA` in apps/worker/src/main.ts. */
const PG_BOSS_SCHEMA = 'pgboss' as const;

@Injectable()
export class PgBossJobProducer implements IJobProducer, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgBossJobProducer.name);
  private boss: PgBoss | null = null;
  private startPromise: Promise<PgBoss> | null = null;

  /** v8 §v7-D / Perf-HIGH: pre-connect on module init so the first
   *  /imports/:id/start doesn't pay ~200-400ms of pg-boss cold-start
   *  latency on the request path. Fire-and-forget (best-effort) —
   *  if it fails we still fall back to the lazy `send()` path. We
   *  start asynchronously so a slow pg-boss connect can't block
   *  Nest's bootstrap (the request handler still awaits getBoss()
   *  before sending; if pre-connect is still in flight the first
   *  request piggybacks on the in-flight promise).
   *
   *  Tests still work — unit tests typically don't bootstrap the
   *  module via Nest; they instantiate the class directly and never
   *  trigger onModuleInit. The Fake producer in tests has its own
   *  noop onModuleInit. */
  async onModuleInit(): Promise<void> {
    if (process.env['NODE_ENV'] === 'test') return;
    // Don't await — let Nest finish bootstrapping while pg-boss
    // connects in the background. The first send() awaits the same
    // startPromise.
    void this.getBoss().catch((e) => {
      this.logger.warn(
        `pg-boss producer pre-connect failed (will retry on first send): ${
          e instanceof Error ? e.message : 'unknown'
        }`,
      );
      // Drop the failed startPromise so the next send() retries.
      this.startPromise = null;
    });
  }

  /** Lazy connection. First send() triggers `boss.start()`; subsequent
   *  sends reuse the same instance. Pre-connect via onModuleInit
   *  amortises the cold-start cost off the request path (v8 §v7-D). */
  private async getBoss(): Promise<PgBoss> {
    if (this.boss) return this.boss;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const boss = new PgBoss({
        connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL,
        schema: PG_BOSS_SCHEMA,
        // v5 audit fix (HIGH cross-confirmed by SOLID + perf agents):
        // pg-boss defaults migrate:true on start(). With BOTH the
        // worker AND this api producer calling start() concurrently
        // on first deploy, the schema migration becomes a race
        // (pg-boss v10 documented advisory-lock guard mitigates this,
        // but defense-in-depth: the worker is the canonical schema
        // OWNER; the api is producer-only and MUST NOT apply DDL).
        // This also speeds api cold-start.
        migrate: false,
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
