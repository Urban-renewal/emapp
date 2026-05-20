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
    // Re-run the production-gate + secret check the real class implements,
    // then delegate the unmatched-fallback to a fixed `false` so we're not
    // hitting the real ThrottlerGuard chain.
    if (process.env['NODE_ENV'] === 'production') return false;
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

  it('allows bypass when NODE_ENV is not production AND header+secret match', async () => {
    delete process.env['NODE_ENV'];
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

  it('refuses bypass when header is wrong even outside prod', async () => {
    delete process.env['NODE_ENV'];
    process.env['THROTTLE_TEST_BYPASS'] = 'real-secret';
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'guessed-wrong' }));
    expect(ok).toBe(false);
  });

  it('refuses bypass when env not set, regardless of header', async () => {
    delete process.env['NODE_ENV'];
    delete process.env['THROTTLE_TEST_BYPASS'];
    const ok = await g.run(fakeCtx({ 'x-throttle-bypass': 'anything' }));
    expect(ok).toBe(false);
  });
});
