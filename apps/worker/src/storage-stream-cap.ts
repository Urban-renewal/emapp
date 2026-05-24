/**
 * Streaming byte ceiling — v7 P0 security fix.
 *
 * Background (the gap)
 * --------------------
 * API enforces a 50MB upload cap two ways:
 *   1. Zod validates `fileSizeBytes <= IMPORT_MAX_SIZE_BYTES` on /imports
 *   2. The presigned PUT we mint to R2 sets `ContentLength` to that size
 *
 * Neither of those binds the worker on the DOWNLOAD side. R2's presign
 * is a SIZE-AT-UPLOAD attestation, not a download integrity gate; once
 * the bytes are in the bucket, `getObjectStream(key)` will hand back
 * whatever R2 stores there — including objects placed by some future
 * out-of-band path (admin overwrite, bucket replication, key collision
 * after a buggy migration) that could be GBs.
 *
 * Without a worker-side ceiling, `parseExcelFull(stream)` happily pipes
 * the whole thing into ExcelJS's streaming parser, which buffers an
 * unbounded sheet into RAM. A single oversized object can OOM the
 * worker process — a low-cost DoS for any attacker who can put bytes
 * in the bucket (or a footgun for an honest admin upload).
 *
 * Design
 * ------
 * Wrap the storage Readable in a PassThrough that counts emitted bytes
 * and `destroy(StreamSizeExceededError)`s the moment we cross
 * `maxBytes`. Downstream (`parseExcelFull`) propagates the error; the
 * caller in import-job.handler.ts maps it to a NonRetryableJobError
 * (a malformed-too-big file is not going to get smaller on retry).
 *
 * We also `destroy()` the upstream R2 source to release the SDK socket
 * back to the pool — without that, the upstream keeps producing into a
 * disconnected pipe until R2 closes the connection (seconds of wasted
 * bandwidth + a leaked socket from the SDK's connection pool, which is
 * exactly what the connection-pool perf MEDIUM also wants to avoid).
 *
 * Why not put this in @emapp/db's R2 provider
 * -------------------------------------------
 * The provider is a thin SDK wrapper; the policy (HOW MUCH is too much)
 * belongs to the consumer. The API uses the same `getObjectStream` for
 * future document downloads where the ceiling is different (or absent).
 * Keeping policy at the call site = no per-provider config sprawl.
 */
import { PassThrough, type Readable } from 'node:stream';

import { IMPORT_MAX_SIZE_BYTES } from '@emapp/shared-types';

/** Thrown when the streamed object exceeds the configured cap. The
 *  handler matches on `code` to translate to a non-retryable job error. */
export class StreamSizeExceededError extends Error {
  readonly code = 'stream_size_exceeded' as const;
  constructor(
    readonly capBytes: number,
    readonly observedAtLeast: number,
  ) {
    super(
      `R2 object stream exceeded byte ceiling: ${observedAtLeast} > ${capBytes} bytes (cap=${capBytes})`,
    );
    this.name = 'StreamSizeExceededError';
  }
}

/**
 * Wrap a Readable so that no more than `maxBytes` ever flow through.
 * On overflow:
 *   - the wrapper emits `error` with a StreamSizeExceededError;
 *   - the upstream is `destroy()`ed (frees the R2 SDK socket).
 *
 * The wrapper is itself a Readable so it slots into any pipe chain
 * (`pipe(parser)`, `for await (const chunk of stream)`, etc.).
 */
export function capStreamSize(
  upstream: Readable,
  maxBytes: number = IMPORT_MAX_SIZE_BYTES,
): Readable {
  // Defense-in-depth on caller arg.
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`capStreamSize: maxBytes must be > 0 (got ${maxBytes})`);
  }

  let received = 0;
  const out = new PassThrough();

  upstream.on('data', (chunk: Buffer | string) => {
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    received += len;
    if (received > maxBytes) {
      // Pull the rip-cord on both ends. Order matters: destroy `out`
      // first so the consumer sees the error before we tear down the
      // upstream (a torn-down upstream without an error on `out` would
      // look like a clean EOF to a chunked parser — silently truncated
      // data, the worst kind of failure).
      const err = new StreamSizeExceededError(maxBytes, received);
      out.destroy(err);
      upstream.destroy(err);
      return;
    }
    // Backpressure: respect the consumer's write signal.
    if (!out.write(chunk)) {
      upstream.pause();
    }
  });

  out.on('drain', () => {
    upstream.resume();
  });

  upstream.on('end', () => {
    out.end();
  });
  upstream.on('error', (e) => {
    out.destroy(e);
  });

  return out;
}
