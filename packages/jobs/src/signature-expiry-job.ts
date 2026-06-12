/**
 * The `sweep:signature-expiry` job — V12 slice-1 critic follow-up
 * (periodic maintenance, third consumer of the periodic-runner
 * infrastructure after `reaper:expired-rows` + `retention:audit-log`).
 *
 * signature_requests rows with status='pending' AND expires_at <= now()
 * are DERIVED as expired by the FE and by the create()/bulk dedup
 * predicates, but the DB rows themselves stayed 'pending' forever after
 * the one-shot 0063 backfill. This job's handler flips them to the
 * (already-CHECK-admitted, migration 0063) 'expired' status on a cron
 * so DB rows + counts + lists agree with the derived truth and a future
 * "your link expired" notify has a real state transition to hook.
 *
 * NO payload. The sweep is a pure tick — it has no per-invocation
 * parameters. pg-boss's `schedule(name, cron)` enqueues a job with an
 * empty `{}` data object on each cron fire; the schema below validates
 * exactly that (strict empty object) so a tampered enqueue carrying
 * unexpected fields is rejected before the handler runs.
 */
import { z } from 'zod';

/** Job name registered with pg-boss. Namespaced with `sweep:` —
 *  distinct from the `reaper:` (ephemeral-row DELETE) and `retention:`
 *  (compliance-floor prune) namespaces because this job MUTATES domain
 *  state rather than deleting housekeeping rows. */
export const SIGNATURE_EXPIRY_JOB_NAME = 'sweep:signature-expiry' as const;

/** Cron cadence — hourly, at :30. Offset from the reaper's on-the-hour
 *  tick so the two maintenance jobs never contend for the same pg-boss
 *  fetch window or DB write burst. An expired link is already treated
 *  as dead by every read path the instant `expires_at` passes, so the
 *  sweep is state reconciliation, not enforcement — hourly is plenty.
 *  The cron is evaluated by pg-boss in UTC (its `schedule` default tz). */
export const SIGNATURE_EXPIRY_CRON_HOURLY = '30 * * * *' as const;

/** Validated payload. The sweep takes NO parameters — `.strict()` on an
 *  empty object means any extra field is rejected, matching the rest of
 *  the codebase's defense against payload confusion on the shared queue. */
export const SignatureExpiryJobPayloadSchema = z.object({}).strict();

export type SignatureExpiryJobPayload = z.infer<typeof SignatureExpiryJobPayloadSchema>;
