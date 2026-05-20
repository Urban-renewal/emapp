/**
 * pg-boss adapter unit tests — pure logic, no real pg-boss, no DB.
 *
 * Pins the contract main.ts + ImportJobHandler depend on:
 *   1. registerHandler calls createQueue with the handler's name + retry/timeout settings
 *   2. registerHandler subscribes via work() with batchSize:1 + the configured concurrency
 *   3. payload is Zod-validated BEFORE handler.handle is called
 *   4. malformed payload → handler is NEVER invoked, error is thrown
 *   5. handler exceptions propagate (retryable error path)
 *   6. NonRetryableJobError propagates as-is (boss skips retries)
 *   7. logger metadata carries jobId + attempt for correlation
 */
import { NonRetryableJobError, type IJobHandler } from '@emapp/jobs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { registerHandler, type BossLike } from '../src/pg-boss-adapter';

const Payload = z.object({ x: z.number() }).strict();
type Payload = z.infer<typeof Payload>;

function makeHandler(impl: (p: Payload) => Promise<void> = async () => {}): IJobHandler<Payload> & {
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  return {
    name: 'test.job',
    timeoutMs: 5_000,
    maxRetries: 1,
    handle: spy as unknown as IJobHandler<Payload>['handle'],
    spy,
  };
}

interface BossTestState {
  createQueueCalls: Array<{ name: string; options?: Record<string, unknown> }>;
  workCalls: Array<{ name: string; options: Record<string, unknown> }>;
  workHandler: ((jobs: { id: string; data: unknown }[]) => Promise<unknown>) | null;
}

function makeBoss(): { boss: BossLike; state: BossTestState } {
  const state: BossTestState = {
    createQueueCalls: [],
    workCalls: [],
    workHandler: null,
  };
  const boss: BossLike = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    createQueue: vi.fn(async (name: string, options?: Record<string, unknown>) => {
      state.createQueueCalls.push({ name, options });
    }),
    work: vi.fn(async (name: string, options, handler) => {
      state.workCalls.push({ name, options });
      state.workHandler = handler as typeof state.workHandler;
      return `worker-${name}`;
    }),
  };
  return { boss, state };
}

function mockLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('pg-boss adapter', () => {
  it('1) createQueue is called with handler name + retry/timeout settings', async () => {
    const { boss, state } = makeBoss();
    const handler = makeHandler();
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockLog(),
      signal: new AbortController().signal,
    });
    expect(state.createQueueCalls).toHaveLength(1);
    expect(state.createQueueCalls[0]!.name).toBe('test.job');
    expect(state.createQueueCalls[0]!.options).toMatchObject({
      retryLimit: 1,
      expireInSeconds: 5,
    });
  });

  it('2) work() is called with batchSize:1 + configured concurrency', async () => {
    const { boss, state } = makeBoss();
    const handler = makeHandler();
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockLog(),
      signal: new AbortController().signal,
      concurrency: 4,
    });
    expect(state.workCalls).toHaveLength(1);
    expect(state.workCalls[0]!.options).toMatchObject({
      batchSize: 1,
      teamConcurrency: 4,
      includeMetadata: false,
    });
  });

  it('3) valid payload reaches handler.handle as parsed type', async () => {
    const { boss, state } = makeBoss();
    const handler = makeHandler();
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockLog(),
      signal: new AbortController().signal,
    });
    expect(state.workHandler).not.toBeNull();
    await state.workHandler!([{ id: 'job-1', data: { x: 42 } }]);
    expect(handler.spy).toHaveBeenCalledTimes(1);
    expect(handler.spy).toHaveBeenCalledWith({ x: 42 }, expect.any(Object));
  });

  it('4) malformed payload → handler NEVER called, error thrown', async () => {
    const { boss, state } = makeBoss();
    const handler = makeHandler();
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockLog(),
      signal: new AbortController().signal,
    });
    await expect(
      state.workHandler!([{ id: 'job-2', data: { x: 'not-a-number' } }]),
    ).rejects.toThrow();
    expect(handler.spy).not.toHaveBeenCalled();
  });

  it('5) handler retryable error propagates', async () => {
    const { boss, state } = makeBoss();
    const handler = makeHandler(async () => {
      throw new Error('db blip');
    });
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockLog(),
      signal: new AbortController().signal,
    });
    await expect(state.workHandler!([{ id: 'job-3', data: { x: 1 } }])).rejects.toThrow(/db blip/);
  });

  it('6) NonRetryableJobError propagates with code', async () => {
    const { boss, state } = makeBoss();
    const handler = makeHandler(async () => {
      throw new NonRetryableJobError('bad payload', 'invalid_file');
    });
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log: mockLog(),
      signal: new AbortController().signal,
    });
    let caught: unknown;
    try {
      await state.workHandler!([{ id: 'job-4', data: { x: 1 } }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NonRetryableJobError);
    expect((caught as NonRetryableJobError).code).toBe('invalid_file');
  });

  it('7) scoped logger threads jobId/attempt into every entry', async () => {
    const { boss, state } = makeBoss();
    const log = mockLog();
    const handler = makeHandler(async (_p, ctx) => {
      ctx.log.info('stage X', { extra: 'value' });
    });
    await registerHandler({
      boss,
      registration: { handler, payloadSchema: Payload },
      log,
      signal: new AbortController().signal,
    });
    await state.workHandler!([{ id: 'job-5', data: { x: 1 } }]);
    expect(log.info).toHaveBeenCalledWith(
      'stage X',
      expect.objectContaining({ jobId: 'job-5', attempt: 1, extra: 'value' }),
    );
  });
});
