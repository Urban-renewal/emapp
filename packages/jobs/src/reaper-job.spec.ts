/**
 * Job-contract tests for the reaper job (Phase 3 #5a).
 *
 * Pure unit tests — no DB. They pin the queue-boundary contract that the
 * worker relies on:
 *  - the cron cadence + job name constants (so a typo or accidental
 *    cadence change trips a test, not production),
 *  - and — load-bearing — that `ReaperJobPayloadSchema` is `.strict()`:
 *    the reaper takes NO parameters, so a tampered enqueue carrying extra
 *    fields MUST be rejected before the handler runs (payload-confusion
 *    defense on the shared pg-boss queue).
 */
import { describe, expect, it } from 'vitest';

import { REAPER_JOB_NAME, REAPER_CRON_HOURLY, ReaperJobPayloadSchema } from './reaper-job';

describe('reaper job contract (Phase 3 #5a)', () => {
  describe('6a. ReaperJobPayloadSchema is tamper-proof (.strict empty object)', () => {
    it('accepts the empty payload pg-boss enqueues', () => {
      const r = ReaperJobPayloadSchema.safeParse({});
      expect(r.success).toBe(true);
    });

    it('REJECTS a payload carrying an unexpected extra field', () => {
      const r = ReaperJobPayloadSchema.safeParse({ table: 'auth_sessions' });
      expect(r.success).toBe(false);
    });

    it('REJECTS an attempt to smuggle a where-override / target list', () => {
      const r = ReaperJobPayloadSchema.safeParse({
        targets: [{ table: 'users', whereExpired: '1=1' }],
      });
      expect(r.success).toBe(false);
    });

    it('REJECTS non-object payloads', () => {
      expect(ReaperJobPayloadSchema.safeParse(null).success).toBe(false);
      expect(ReaperJobPayloadSchema.safeParse('drop').success).toBe(false);
      expect(ReaperJobPayloadSchema.safeParse([]).success).toBe(false);
    });
  });

  describe('6b. cron + name constants', () => {
    it('job name is the namespaced reaper:expired-rows', () => {
      expect(REAPER_JOB_NAME).toBe('reaper:expired-rows');
    });

    it('cron cadence is hourly-on-the-hour (5-field cron)', () => {
      expect(REAPER_CRON_HOURLY).toBe('0 * * * *');
      expect(REAPER_CRON_HOURLY.trim().split(/\s+/)).toHaveLength(5);
    });
  });
});
