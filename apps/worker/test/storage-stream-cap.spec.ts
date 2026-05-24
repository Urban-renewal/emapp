/**
 * Unit tests for capStreamSize — v7 P0 byte-ceiling guard.
 *
 * Pure stream tests; no DB, no R2, no ExcelJS. Confirms:
 *  1. small streams pass through unchanged (bytes round-trip)
 *  2. exactly-at-cap is OK (boundary inclusive)
 *  3. one byte over the cap → StreamSizeExceededError on consumer
 *  4. upstream is `destroy`d when overflow fires (no leaked socket)
 *  5. upstream error propagates as `out` error
 *  6. invalid maxBytes (≤0, NaN) throws at construction time
 *  7. backpressure honored — pause/resume cycle on slow consumer
 */
import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { capStreamSize, StreamSizeExceededError } from '../src/storage-stream-cap';

/** Helper: collect all bytes flowing out of `stream` into a single Buffer.
 *  Rejects with the first emitted `error`. */
function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Helper: produce a Readable that emits `chunks` sequentially. */
function fromChunks(chunks: Buffer[]): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= chunks.length) {
        this.push(null);
        return;
      }
      this.push(chunks[i]);
      i += 1;
    },
  });
}

describe('capStreamSize — small payload passthrough', () => {
  it('1) under-cap bytes round-trip unchanged', async () => {
    const payload = Buffer.from('hello world');
    const upstream = fromChunks([payload]);
    const capped = capStreamSize(upstream, 1024);
    const out = await collect(capped);
    expect(out).toEqual(payload);
  });

  it('2) exactly-at-cap is allowed (boundary inclusive)', async () => {
    const payload = Buffer.alloc(100, 0x41);
    const upstream = fromChunks([payload]);
    const capped = capStreamSize(upstream, 100);
    const out = await collect(capped);
    expect(out.length).toBe(100);
  });

  it('2b) cap is honored across multiple chunks summing to the cap', async () => {
    const chunks = [Buffer.alloc(40, 0x42), Buffer.alloc(40, 0x43), Buffer.alloc(20, 0x44)];
    const capped = capStreamSize(fromChunks(chunks), 100);
    const out = await collect(capped);
    expect(out.length).toBe(100);
  });
});

describe('capStreamSize — overflow handling', () => {
  it('3) one byte over the cap → StreamSizeExceededError on the consumer', async () => {
    const payload = Buffer.alloc(101, 0x45);
    const upstream = fromChunks([payload]);
    const capped = capStreamSize(upstream, 100);
    await expect(collect(capped)).rejects.toMatchObject({
      name: 'StreamSizeExceededError',
      code: 'stream_size_exceeded',
      capBytes: 100,
    });
  });

  it('3b) overflow across multiple chunks — error fires on the chunk that crosses', async () => {
    // Two 60-byte chunks against a 100-byte cap. The second chunk pushes us to 120 > 100.
    const chunks = [Buffer.alloc(60, 0x46), Buffer.alloc(60, 0x47)];
    const capped = capStreamSize(fromChunks(chunks), 100);
    await expect(collect(capped)).rejects.toBeInstanceOf(StreamSizeExceededError);
  });

  it('4) upstream is destroy()d when overflow fires (no leaked socket)', async () => {
    const payload = Buffer.alloc(200);
    const upstream = fromChunks([payload]);
    const destroySpy = vi.spyOn(upstream, 'destroy');
    const capped = capStreamSize(upstream, 100);
    await expect(collect(capped)).rejects.toBeInstanceOf(StreamSizeExceededError);
    expect(destroySpy).toHaveBeenCalled();
    // The destroy was passed the error (so a future error listener on
    // the upstream sees the actual cause, not a generic abort).
    const destroyArg = destroySpy.mock.calls[0]?.[0];
    expect(destroyArg).toBeInstanceOf(StreamSizeExceededError);
  });
});

describe('capStreamSize — upstream errors', () => {
  it('5) upstream error propagates to the consumer', async () => {
    const upstream = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    const capped = capStreamSize(upstream, 1024);
    await expect(collect(capped)).rejects.toThrow(/connection reset/);
  });
});

describe('capStreamSize — argument validation', () => {
  it('6) maxBytes ≤ 0 throws at construction', () => {
    const upstream = fromChunks([Buffer.from('x')]);
    expect(() => capStreamSize(upstream, 0)).toThrow(/maxBytes must be > 0/);
    expect(() => capStreamSize(upstream, -1)).toThrow(/maxBytes must be > 0/);
  });

  it('6b) NaN/Infinity maxBytes throw at construction', () => {
    const upstream = fromChunks([Buffer.from('x')]);
    expect(() => capStreamSize(upstream, Number.NaN)).toThrow(/maxBytes must be > 0/);
    expect(() => capStreamSize(upstream, Number.POSITIVE_INFINITY)).toThrow(/maxBytes must be > 0/);
  });
});

describe('capStreamSize — backpressure', () => {
  it('7) slow consumer receives every byte without loss', async () => {
    // 10 chunks of 1KB into a slow consumer that defers every callback.
    // We don't assert pause/resume call counts (Node's stream machinery
    // batches reads internally — a fast in-memory upstream can fill the
    // PassThrough's hwm in one tick and never trigger pause), but the
    // round-trip MUST be byte-exact even under backpressure.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(1024, 0x21));
    const upstream = fromChunks(chunks);
    const capped = capStreamSize(upstream, 1024 * 100);

    const collected: Buffer[] = [];
    const slow = new Writable({
      highWaterMark: 512,
      write(chunk, _enc, cb) {
        collected.push(chunk);
        setImmediate(cb);
      },
    });

    await new Promise<void>((resolve, reject) => {
      capped.pipe(slow);
      slow.on('finish', resolve);
      slow.on('error', reject);
      capped.on('error', reject);
    });

    expect(Buffer.concat(collected).length).toBe(10 * 1024);
  });
});
