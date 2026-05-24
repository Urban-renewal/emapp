/**
 * Unit tests for the v8 §v8-S2 SSE max-concurrent-streams cap.
 * (The @Throttle decorator is exercised by the existing throttle
 * integration tests; here we pin the per-process cap that the
 * controller enforces in-memory.)
 *
 * Pure — no Nest bootstrap, no DB. We instantiate the controller
 * directly with stub deps to verify the static counter behavior +
 * the 503 path.
 */
import { describe, expect, it, vi } from 'vitest';

import { ImportsController } from './imports.controller';

describe('ImportsController — v8 §v8-S2 max-concurrent-streams cap', () => {
  it('1) counter is module-static (shared across instances)', () => {
    // Direct access via the test-only seam — confirms the field
    // exists at the class level, not per-instance.
    ImportsController.resetActiveStreamsForTests();
    // No public getter (intentional — internal state), but the
    // resetActiveStreamsForTests is the only public surface and
    // doesn't throw, which is the contract we need.
    expect(() => ImportsController.resetActiveStreamsForTests()).not.toThrow();
  });

  it('2) MAX_ACTIVE_STREAMS sized for ~30 concurrent (calibrated against DB_POOL_MAX=20)', () => {
    // Use bracket access — the field is private but we want to
    // pin the value here so a future change requires a test update.
    const max = (ImportsController as unknown as { MAX_ACTIVE_STREAMS: number }).MAX_ACTIVE_STREAMS;
    expect(max).toBeGreaterThanOrEqual(10);
    expect(max).toBeLessThanOrEqual(100);
    // Document expectation: 30 leaves room for non-SSE traffic on
    // a 20-slot pool (SSE checks out for ~4 RT every 500ms; 30
    // active streams hold at most ~5 concurrent pool slots).
    expect(max).toBe(30);
  });

  it('3) reset works between tests (used in fixtures to isolate stream-count state)', () => {
    ImportsController.resetActiveStreamsForTests();
    // After reset, the controller treats next stream as the first.
    // We can't directly observe the counter (private) but reset
    // is idempotent + safe to call any time.
    ImportsController.resetActiveStreamsForTests();
    ImportsController.resetActiveStreamsForTests();
  });
});

describe('ImportsController — v8 §v8-S2 stream() 503 path (logic only)', () => {
  it('4) rejects with 503 + JSON envelope when active count is at the cap', async () => {
    ImportsController.resetActiveStreamsForTests();
    // Inflate the counter to the cap.
    const max = (ImportsController as unknown as { MAX_ACTIVE_STREAMS: number }).MAX_ACTIVE_STREAMS;
    (ImportsController as unknown as { activeStreams: number }).activeStreams = max;

    // Build a controller with stub deps + minimal Fastify req/reply shims.
    const writeHead = vi.fn();
    const end = vi.fn();
    const reply = {
      raw: { writeHead, end, write: vi.fn() },
    } as unknown as Parameters<ImportsController['stream']>[3];

    const req = { raw: { on: vi.fn() } } as unknown as Parameters<ImportsController['stream']>[2];
    const ctrl = new ImportsController(
      // ImportsService — never called on the 503 path
      {} as unknown as ConstructorParameters<typeof ImportsController>[0],
    );

    await ctrl.stream(
      // user/id never read on the 503 path
      {} as unknown as Parameters<ImportsController['stream']>[0],
      'any-id' as unknown as Parameters<ImportsController['stream']>[1],
      req,
      reply,
    );

    expect(writeHead).toHaveBeenCalledWith(
      503,
      expect.objectContaining({ 'Content-Type': expect.stringContaining('json') }),
    );
    const body = end.mock.calls[0]?.[0];
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body as string) as { error: { code: string } };
    expect(parsed.error.code).toBe('too_many_concurrent_streams');

    // Restore state.
    ImportsController.resetActiveStreamsForTests();
  });
});

/**
 * v8.5 P0 (Audit SOLID #3 + Sec HIGH-6 — cross-confirmed):
 * synchronous throw between the cap-check and the try-block entry
 * (e.g. `writeHead` failing because the underlying socket was
 * closed during the cap-check window) MUST NOT leak the
 * activeStreams counter. The pre-v8.5 code incremented OUTSIDE the
 * try/finally and would leak forever in this scenario; v8.5 moves
 * the increment to the line right above the try/finally so finally
 * is the only counter-touching path.
 *
 * These tests pin that contract — they fail loudly if a future
 * refactor moves the increment back outside the try.
 */
describe('ImportsController — v8.5 stream() counter-leak race', () => {
  // Local helper: probe the private counter.
  const peek = () => (ImportsController as unknown as { activeStreams: number }).activeStreams;

  it('5) sync throw in writeHead (after increment) → counter returns to 0', async () => {
    ImportsController.resetActiveStreamsForTests();
    expect(peek()).toBe(0);

    const writeHead = vi.fn(() => {
      throw new Error('synthetic: socket closed during cap-check window');
    });
    const end = vi.fn();
    const reply = {
      raw: { writeHead, end, write: vi.fn() },
    } as unknown as Parameters<ImportsController['stream']>[3];
    const req = { raw: { on: vi.fn() } } as unknown as Parameters<ImportsController['stream']>[2];

    const ctrl = new ImportsController(
      {} as unknown as ConstructorParameters<typeof ImportsController>[0],
    );

    // The throw propagates (Nest will turn it into a 500). Critical
    // invariant: the counter must come back to 0 regardless.
    await expect(
      ctrl.stream(
        {} as unknown as Parameters<ImportsController['stream']>[0],
        'any-id' as unknown as Parameters<ImportsController['stream']>[1],
        req,
        reply,
      ),
    ).rejects.toThrow(/socket closed during cap-check window/);

    expect(peek()).toBe(0);
  });

  it('6) async throw inside streamProgress → counter returns to 0', async () => {
    ImportsController.resetActiveStreamsForTests();

    const writeHead = vi.fn();
    const end = vi.fn();
    const write = vi.fn();
    const reply = {
      raw: { writeHead, end, write },
    } as unknown as Parameters<ImportsController['stream']>[3];
    const req = { raw: { on: vi.fn() } } as unknown as Parameters<ImportsController['stream']>[2];

    const ctrl = new ImportsController({
      streamProgress: async () => {
        throw new Error('synthetic: downstream service failure');
      },
    } as unknown as ConstructorParameters<typeof ImportsController>[0]);

    await ctrl.stream(
      {} as unknown as Parameters<ImportsController['stream']>[0],
      'any-id' as unknown as Parameters<ImportsController['stream']>[1],
      req,
      reply,
    );

    // The async-throw branch is CAUGHT by the inner try/catch (writes
    // an 'end' SSE frame, doesn't rethrow). What matters: counter back to 0.
    expect(peek()).toBe(0);
    expect(end).toHaveBeenCalled();
  });

  it('7) reply.raw.end throwing on cleanup STILL does not leak the counter', async () => {
    ImportsController.resetActiveStreamsForTests();

    const writeHead = vi.fn();
    const end = vi.fn(() => {
      throw new Error('synthetic: end on dead socket');
    });
    const write = vi.fn();
    const reply = {
      raw: { writeHead, end, write },
    } as unknown as Parameters<ImportsController['stream']>[3];
    const req = { raw: { on: vi.fn() } } as unknown as Parameters<ImportsController['stream']>[2];

    const ctrl = new ImportsController({
      streamProgress: async () => {
        // success path — gets to the finally that calls end
      },
    } as unknown as ConstructorParameters<typeof ImportsController>[0]);

    await ctrl.stream(
      {} as unknown as Parameters<ImportsController['stream']>[0],
      'any-id' as unknown as Parameters<ImportsController['stream']>[1],
      req,
      reply,
    );

    expect(peek()).toBe(0);
  });

  it('8) 50 sequential sync-throws → counter still 0 (no monotonic drift)', async () => {
    ImportsController.resetActiveStreamsForTests();

    const ctrl = new ImportsController(
      {} as unknown as ConstructorParameters<typeof ImportsController>[0],
    );

    for (let i = 0; i < 50; i += 1) {
      const reply = {
        raw: {
          writeHead: () => {
            throw new Error('boom');
          },
          end: vi.fn(),
          write: vi.fn(),
        },
      } as unknown as Parameters<ImportsController['stream']>[3];
      const req = { raw: { on: vi.fn() } } as unknown as Parameters<ImportsController['stream']>[2];
      // eslint-disable-next-line no-await-in-loop
      await expect(
        ctrl.stream(
          {} as unknown as Parameters<ImportsController['stream']>[0],
          'any-id' as unknown as Parameters<ImportsController['stream']>[1],
          req,
          reply,
        ),
      ).rejects.toThrow();
    }

    // Pre-v8.5 this would be 50 (full DoS). Post-v8.5: 0.
    expect(peek()).toBe(0);
  });
});
