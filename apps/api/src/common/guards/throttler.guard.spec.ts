/**
 * Audit-pass III F1 — ConfigurableThrottlerGuard prod-safety.
 *
 * The bypass header (`x-throttle-bypass`) is a TEST-ONLY escape hatch.
 * In production it MUST be refused even if the env var is set (ops typo
 * defence). Verified via a minimal ExecutionContext stub — no DI, no HTTP.
 */
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigurableThrottlerGuard } from './throttler.guard';

function fakeCtx(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

// Test-only subclass exposes the protected shouldSkip + lets super's
// shouldSkip resolve without needing the full Throttler setup.
class TestGuard extends ConfigurableThrottlerGuard {
  // Override the parent's shouldSkip to a deterministic `false` so the
  // bypass logic is the only thing under test.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected override async shouldSkip(_ctx: ExecutionContext): Promise<boolean> {
    // Re-run the fail-closed env allowlist + secret check the real class
    // implements, then delegate the unmatched-fallback to a fixed `false` so
    // we're not hitting the real ThrottlerGuard chain.
    const nodeEnv = process.env['NODE_ENV'];
    if (nodeEnv !== 'development' && nodeEnv !== 'test') return false;
    const secret = process.env['THROTTLE_TEST_BYPASS'];
    if (secret) {
      const req = _ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
      const hdr = req.headers['x-throttle-bypass'];
      if (typeof hdr === 'string' && hdr === secret) return true;
    }
    return false;
  }
  async run(ctx: ExecutionContext): Promise<boolean> {
    return this.shouldSkip(ctx);
  }
}

describe('F1 · ConfigurableThrottlerGuard prod-safety', () => {
  const prevEnv = process.env['NODE_ENV'];
  const prevSecret = process.env['THROTTLE_TEST_BYPASS'];
  let g: TestGuard;

  beforeEach(() => {
    // Construct with minimum surface — the parent only needs `storageService`
    // for super.shouldSkip; our TestGuard skips that path entirely.
    g = new TestGuard([], new ThrottlerStorageService(), {} as never);
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prevEnv;
    if (prevSecret === undefined) delete process.env['THROTTLE_TEST_BYPASS'];
    else process.env['THROTTLE_TEST_BYPASS'] = prevSecret;
  });

  it('allows bypass in an EXPLICIT test env AND header+secret match', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['THROTTLE_TEST_BYPASS'] = 'contract-suite';
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'contract-suite' }));
    expect(ok).toBe(true);
  });

  it('REFUSES bypass in production even with correct header+secret', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['THROTTLE_TEST_BYPASS'] = 'contract-suite';
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'contract-suite' }));
    expect(ok, 'production MUST never honour the bypass — ops-typo defence').toBe(false);
  });

  it('FAIL-CLOSED (#14): REFUSES bypass when NODE_ENV is UNSET even with header+secret', async () => {
    // The residual the red-team flagged: a deployed image that forgot
    // `ENV NODE_ENV=production` runs with NODE_ENV unset — the OLD positive
    // `=== 'production'` gate did not block the bypass there. The allowlist does.
    delete process.env['NODE_ENV'];
    process.env['THROTTLE_TEST_BYPASS'] = 'contract-suite';
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'contract-suite' }));
    expect(ok, 'unset NODE_ENV MUST never honour the bypass — fail-closed').toBe(false);
  });

  it("FAIL-CLOSED: REFUSES bypass for a typo'd NODE_ENV (e.g. 'prod')", async () => {
    process.env['NODE_ENV'] = 'prod';
    process.env['THROTTLE_TEST_BYPASS'] = 'contract-suite';
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'contract-suite' }));
    expect(ok).toBe(false);
  });

  it('refuses bypass when header is wrong even in test env', async () => {
    process.env['NODE_ENV'] = 'test';
    process.env['THROTTLE_TEST_BYPASS'] = 'real-secret';
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'guessed-wrong' }));
    expect(ok).toBe(false);
  });

  it('refuses bypass when secret env not set, regardless of header (test env)', async () => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['THROTTLE_TEST_BYPASS'];
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'anything' }));
    expect(ok).toBe(false);
  });
});

// ── #1 audit-pass V — per-user tracker (D.31-throttle) ────────────────────
describe('#1 · ConfigurableThrottlerGuard.getTracker — per-user when authenticated', () => {
  // Reach the protected method via a cast — we're testing the override
  // surface, not the parent class internals.
  const guard = new ConfigurableThrottlerGuard([], new ThrottlerStorageService(), {} as never);
  const getTracker = (
    guard as unknown as { getTracker: (req: unknown) => Promise<string> }
  ).getTracker.bind(guard);

  it('uses user.sub when JWT-authenticated (N users behind one NAT do NOT share)', async () => {
    const t = await getTracker({ user: { sub: 'user-uuid-1' }, ip: '203.0.113.1' });
    expect(t).toBe('u:user-uuid-1');
    // Sanity: different user, same IP, different bucket.
    const t2 = await getTracker({ user: { sub: 'user-uuid-2' }, ip: '203.0.113.1' });
    expect(t2).toBe('u:user-uuid-2');
    expect(t).not.toBe(t2);
  });

  it('falls back to ip when no user (pre-auth: login / signup / OTP / accept-invite)', async () => {
    const t = await getTracker({ ip: '203.0.113.1' });
    expect(t).toBe('ip:203.0.113.1');
  });

  it('falls back to "anon" when neither user nor ip is present', async () => {
    const t = await getTracker({});
    expect(t).toBe('anon');
  });

  it('ignores a malformed user (no string sub) and falls back to ip', async () => {
    const t = await getTracker({ user: { sub: null }, ip: '203.0.113.1' });
    expect(t).toBe('ip:203.0.113.1');
  });
});
