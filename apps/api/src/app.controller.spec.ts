import { describe, it, expect, vi, beforeEach } from 'vitest';

import { HealthController } from './app.controller';

// P0.B2 — HealthController now takes an IMetricsProvider. A local silent
// no-op stub keeps these tests focused on the liveness/readiness contract
// (the `@emapp/db` mock above only exposes `db`/`sql`, so we don't pull a
// real provider through it).
const noopMetrics = { counter() {}, gauge() {}, timing() {} };

// Mock the db module so we can detect whether the handlers reach into
// it. `/health` (liveness) MUST NOT call `db.execute`; `/ready`
// (readiness) MUST.
vi.mock('@emapp/db', () => ({
  db: {
    execute: vi.fn().mockResolvedValue([]),
  },
  sql: vi.fn((strings: TemplateStringsArray) => strings.join('')),
}));

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const { db } = await import('@emapp/db');
    vi.mocked(db.execute).mockClear();
    controller = new HealthController(noopMetrics);
  });

  describe('GET /health (liveness)', () => {
    it('returns status ok WITHOUT touching the DB', async () => {
      const { db } = await import('@emapp/db');
      const result = controller.getHealth();
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
      expect(typeof result.timestamp).toBe('string');
      // F-PERF-2 invariant — the whole point of the split.
      expect(db.execute).not.toHaveBeenCalled();
    });

    it('returns synchronously (no Promise / no awaitable work)', () => {
      const result = controller.getHealth();
      // Plain object, not a thenable.
      expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
    });

    it('does NOT include a `db` field (liveness ≠ readiness)', () => {
      const result = controller.getHealth();
      expect(Object.keys(result).sort()).toEqual(['status', 'timestamp', 'uptime']);
    });
  });

  describe('GET /ready (readiness)', () => {
    it('returns status ok with db=connected when the ping succeeds', async () => {
      const { db } = await import('@emapp/db');
      const result = await controller.getReady();
      expect(result.status).toBe('ok');
      expect(result.db).toBe('connected');
      expect(db.execute).toHaveBeenCalledOnce();
    });

    it('returns status degraded with db=disconnected when the ping throws', async () => {
      const { db } = await import('@emapp/db');
      vi.mocked(db.execute).mockRejectedValueOnce(new Error('connection refused'));

      const result = await controller.getReady();
      expect(result.status).toBe('degraded');
      expect(result.db).toBe('disconnected');
    });

    it('does NOT leak DB error details into the response envelope', async () => {
      const { db } = await import('@emapp/db');
      const detailedError = new Error('ECONNREFUSED 127.0.0.1:5432 — password is "hunter2"');
      vi.mocked(db.execute).mockRejectedValueOnce(detailedError);

      const result = await controller.getReady();
      // The thrown message must NOT appear anywhere in the body
      // (Doc 07 §5 — generic error messages, never stack traces or
      // secrets). The result is type-stable: 'degraded' / 'disconnected'.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('ECONNREFUSED');
      expect(serialized).not.toContain('127.0.0.1');
    });
  });
});
