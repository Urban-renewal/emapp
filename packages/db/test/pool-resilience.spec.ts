import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { pool, providerPool } from '../src/client';

// Regression: a pooled Neon connection dropped on idle timeout used to emit
// 'error' on a *checked-out* Client with no listener → unhandled 'error'
// event → process exit 1, taking the whole API down on one transient blip.
// The fix attaches a per-client 'error' handler on the pool 'connect' event,
// plus keepAlive (with an initial delay short enough to fire inside Neon's
// idle window) and allowExitOnIdle:false. The synthetic-emitter tests below
// pin the listener contract deterministically; the real-pg integration test
// proves the behavior under an actual pg.Client error.
describe('pg pool idle-disconnect resilience', () => {
  for (const [label, p] of [
    ['appPool', pool],
    ['providerPool', providerPool],
  ] as const) {
    it(`${label}: 'connect' attaches a per-client 'error' listener`, () => {
      const fakeClient = new EventEmitter();
      p.emit('connect', fakeClient);

      expect(fakeClient.listenerCount('error')).toBeGreaterThan(0);
      // Without a listener EventEmitter throws synchronously on emit('error');
      // with our guard it must be inert.
      expect(() =>
        fakeClient.emit('error', new Error('Connection terminated unexpectedly')),
      ).not.toThrow();
    });

    it(`${label}: has a pool-level 'error' handler for idle clients`, () => {
      expect(p.listenerCount('error')).toBeGreaterThan(0);
    });

    it(`${label}: idle drop produces EXACTLY one log line (no duplication)`, () => {
      // pg-pool's idle path re-emits client errors to pool 'error' on top of
      // the per-client 'error' event. The per-client guard is the single
      // source of truth; the pool listener is a silent backstop. Regression
      // pin: emit BOTH events (mirroring pg's makeIdleListener flow) and
      // assert we wrote exactly one stderr line.
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
      try {
        const fakeClient = new EventEmitter();
        p.emit('connect', fakeClient);
        const err = new Error('Connection terminated unexpectedly');
        fakeClient.emit('error', err); // per-client guard: logs once
        p.emit('error', err); // pool backstop: MUST be silent
      } finally {
        spy.mockRestore();
      }
      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain(`[${label}] client error (reaped):`);
    });

    it(`${label}: resilient defaults (keepAlive + allowExitOnIdle:false) are set`, () => {
      // pg.Pool stores config on .options. We pin the values so a future
      // refactor that drops them can't silently regress the prod-stability
      // contract this bug was filed under.
      const opts = (p as unknown as { options: Record<string, unknown> }).options;
      expect(opts['keepAlive']).toBe(true);
      expect(opts['keepAliveInitialDelayMillis']).toBe(10_000);
      expect(opts['allowExitOnIdle']).toBe(false);
    });
  }

  it('real pg.Client error on a checked-out client does not crash, and the pool recovers', async () => {
    // 1. Acquire a real client and emit the exact error the prod stack showed.
    const client = await pool.connect();
    const totalBefore = pool.totalCount;
    const underlying = (client as unknown as { _client?: EventEmitter })._client ?? client;

    // The bug: this emit on a checked-out client used to be unhandled → exit 1.
    expect(() =>
      (underlying as EventEmitter).emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();

    // 2. Release (errored clients are reaped by pg, not returned to idle).
    try {
      client.release(true);
    } catch {
      /* pg may already have torn the client down — fine */
    }

    // 3. Pool must still serve queries — a fresh client is created on demand.
    const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);

    // Sanity: pool didn't leak the dead client forever.
    expect(pool.totalCount).toBeLessThanOrEqual(totalBefore);
  }, 15_000);
});
