/**
 * Job-contract tests for the audit-retention job (Roadmap P0.C3).
 *
 * Pure unit tests — no DB. They pin the queue-boundary contract:
 *  - the cron cadence + job name constants (a typo or cadence change trips a
 *    test, not production),
 *  - and — load-bearing — that `AuditRetentionJobPayloadSchema` is
 *    `.strict()`: the retention window is config-only + floor-clamped in
 *    @emapp/db, so the queue payload carries NO parameters. A tampered
 *    enqueue trying to smuggle a shorter window MUST be rejected before the
 *    handler runs (the window can never be overridden via the queue).
 */
import { describe, expect, it } from 'vitest';

import {
  AUDIT_RETENTION_JOB_NAME,
  AUDIT_RETENTION_CRON_DAILY,
  AuditRetentionJobPayloadSchema,
} from './audit-retention-job';

describe('audit-retention job contract (P0.C3)', () => {
  describe('payload is tamper-proof (.strict empty object)', () => {
    it('accepts the empty payload pg-boss enqueues', () => {
      expect(AuditRetentionJobPayloadSchema.safeParse({}).success).toBe(true);
    });

    it('REJECTS a payload trying to smuggle a shorter retention window', () => {
      const r = AuditRetentionJobPayloadSchema.safeParse({ months: 1 });
      expect(r.success).toBe(false);
    });

    it('REJECTS a payload carrying any unexpected field', () => {
      expect(AuditRetentionJobPayloadSchema.safeParse({ rawRetentionMonths: '6' }).success).toBe(
        false,
      );
    });

    it('REJECTS non-object payloads', () => {
      expect(AuditRetentionJobPayloadSchema.safeParse(null).success).toBe(false);
      expect(AuditRetentionJobPayloadSchema.safeParse('drop').success).toBe(false);
      expect(AuditRetentionJobPayloadSchema.safeParse([]).success).toBe(false);
    });
  });

  describe('cron + name constants', () => {
    it('job name is the namespaced retention:audit-log', () => {
      expect(AUDIT_RETENTION_JOB_NAME).toBe('retention:audit-log');
    });

    it('cron cadence is a valid 5-field daily cron', () => {
      expect(AUDIT_RETENTION_CRON_DAILY).toBe('15 3 * * *');
      expect(AUDIT_RETENTION_CRON_DAILY.trim().split(/\s+/)).toHaveLength(5);
    });
  });
});
