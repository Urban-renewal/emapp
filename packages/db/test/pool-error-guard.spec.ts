import { EventEmitter } from 'node:events';

import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { attachClientErrorGuard, setPoolErrorObserver } from '../src/client';

// Pure unit test for the resilience guard's observability hook.
// Uses an EventEmitter cast to Pool — we only exercise event wiring,
// no real pg connection is opened.
describe('attachClientErrorGuard observability', () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as MockInstance;
  });

  afterEach(() => {
    setPoolErrorObserver(undefined);
    stderrSpy.mockRestore();
  });

  it('calls the observer when a client errors after connect', () => {
    const fakePool = new EventEmitter() as unknown as Pool;
    attachClientErrorGuard(fakePool, 'providerPool');
    const observer = vi.fn();
    setPoolErrorObserver(observer);

    const fakeClient = new EventEmitter();
    (fakePool as unknown as EventEmitter).emit('connect', fakeClient);
    fakeClient.emit('error', new Error('neon blip'));

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith({
      pool: 'providerPool',
      source: 'client',
      message: 'neon blip',
    });
    expect(stderrSpy).toHaveBeenCalledWith('[providerPool] client error (reaped): neon blip\n');
  });

  it('calls the observer EXACTLY ONCE on a real idle-drop flow (per-client + pool re-emit)', () => {
    // pg-pool's makeIdleListener re-emits client errors to pool.emit('error')
    // ON TOP of the per-client 'error' event. The dedup contract: the
    // per-client guard is the single source of truth; the pool listener is
    // a silent backstop. Observer + stderr fire exactly once per real event.
    const fakePool = new EventEmitter() as unknown as Pool;
    attachClientErrorGuard(fakePool, 'appPool');
    const observer = vi.fn();
    setPoolErrorObserver(observer);

    const fakeClient = new EventEmitter();
    const err = new Error('Connection terminated unexpectedly');
    (fakePool as unknown as EventEmitter).emit('connect', fakeClient);
    fakeClient.emit('error', err); // per-client guard fires
    (fakePool as unknown as EventEmitter).emit('error', err); // pool backstop MUST be silent

    expect(observer).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      '[appPool] client error (reaped): Connection terminated unexpectedly\n',
    );
  });

  it('pool-level error WITHOUT a prior per-client emit is a silent backstop', () => {
    // Defends the invariant: removing the pool listener would re-introduce
    // an unhandled-'error' crash on idle re-emit. The listener is registered
    // but intentionally writes nothing and notifies no observer.
    const fakePool = new EventEmitter() as unknown as Pool;
    attachClientErrorGuard(fakePool, 'appPool');
    const observer = vi.fn();
    setPoolErrorObserver(observer);

    expect(() =>
      (fakePool as unknown as EventEmitter).emit('error', new Error('synthetic')),
    ).not.toThrow();
    expect(observer).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('swallows observer exceptions so the guard never weakens', () => {
    const fakePool = new EventEmitter() as unknown as Pool;
    attachClientErrorGuard(fakePool, 'appPool');
    setPoolErrorObserver(() => {
      throw new Error('observer is broken');
    });

    const fakeClient = new EventEmitter();
    (fakePool as unknown as EventEmitter).emit('connect', fakeClient);
    expect(() => fakeClient.emit('error', new Error('idle drop'))).not.toThrow();
    // stderr still written — the guard's primary signal survives a broken observer.
    expect(stderrSpy).toHaveBeenCalledWith('[appPool] client error (reaped): idle drop\n');
  });

  it('is a no-op when no observer is registered', () => {
    const fakePool = new EventEmitter() as unknown as Pool;
    attachClientErrorGuard(fakePool, 'appPool');

    const fakeClient = new EventEmitter();
    (fakePool as unknown as EventEmitter).emit('connect', fakeClient);
    expect(() => fakeClient.emit('error', new Error('idle drop'))).not.toThrow();
    expect(stderrSpy).toHaveBeenCalled();
  });
});
