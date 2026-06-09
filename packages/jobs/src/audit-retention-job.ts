/**
 * The `retention:audit-log` job — Roadmap P0.C3 (compliance retention).
 *
 * A SECOND periodic-maintenance consumer alongside `reaper:expired-rows`,
 * kept DELIBERATELY SEPARATE from it: the ephemeral reaper deletes rows the
 * app already treats as dead (minutes-to-days TTLs), whereas this job
 * enforces the audit-log RETENTION FLOOR — deleting `audit_log` rows older
 * than the configured window (default 36 months, hard floor 24 months). The
 * ≥24-month floor satisfies the Israeli high-tier Data-Security reg's
 * log-keeping clause; see packages/db helpers/audit-retention.ts for the
 * floor-clamp guarantee and the batched-delete rationale.
 *
 * NO payload. Like the reaper, this is a pure cron tick — the retention
 * window comes from config (AUDIT_RETENTION_MONTHS), never from the job
 * payload, so a tampered enqueue can NEVER shorten the window. The schema
 * below is a strict empty object: any extra field is rejected before the
 * handler runs (payload-confusion defense on the shared pg-boss queue).
 */
import { z } from 'zod';

/** Job name registered with pg-boss. `retention:` namespace distinguishes
 *  the compliance-retention concern from the `reaper:` ephemeral-cleanup
 *  concern on the shared scheduler. */
export const AUDIT_RETENTION_JOB_NAME = 'retention:audit-log' as const;

/** Cron cadence — daily at 03:15 UTC. Retention is a slow-moving floor
 *  (rows age into the window over months), so a daily sweep is ample; the
 *  off-peak hour avoids contending with interactive load, and the batched
 *  delete keeps each run a series of short transactions regardless of
 *  backlog. pg-boss evaluates the cron in UTC. */
export const AUDIT_RETENTION_CRON_DAILY = '15 3 * * *' as const;

/** Validated payload. The job takes NO parameters — `.strict()` on an empty
 *  object rejects any extra field, so the retention window can NEVER be
 *  overridden via the queue (it is config-only + floor-clamped in @emapp/db). */
export const AuditRetentionJobPayloadSchema = z.object({}).strict();

export type AuditRetentionJobPayload = z.infer<typeof AuditRetentionJobPayloadSchema>;
