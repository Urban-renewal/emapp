/**
 * File anti-malware scan provider (P0.B1).
 *
 * Single-responsibility, generic seam — mirrors `ISMSProvider` /
 * `IEmailProvider` / `IStorageProvider`. The documents flow gates a file's
 * downloadability on a `clean` verdict from THIS interface; the concrete
 * implementation (Noop in dev/test, a real AV engine in prod) is selected by
 * the app-side `scanProviderFactory` from env — never `new`'d inline.
 *
 * SECURITY (fail-closed): the security boundary treats ANYTHING that is not an
 * explicit `clean` verdict as "do not serve". `infected` and `error` are both
 * non-clean. A provider that cannot reach its engine MUST return `error`
 * (never throw a `clean`) so the gate stays closed under failure.
 *
 * PRIVACY: implementations MUST NOT log file contents and MUST NOT embed bytes
 * in any returned value. Only the object `key` (an opaque, server-generated,
 * unguessable storage pointer) and an AV `signature` label may be surfaced.
 */
export type ScanVerdict = 'clean' | 'infected' | 'error';

export interface ScanInput {
  /** Server-generated, unguessable storage key of the object to scan. The
   *  provider may use this to stream the bytes itself (e.g. an R2-event or
   *  side-channel scanner) OR ignore it and use `bytes` when supplied. */
  key: string;
  /**
   * The object bytes, or a lazy loader for them. Optional: a provider that
   * fetches bytes out-of-band (its own R2/S3 read, an event-driven sidecar)
   * does not need them. The loader form lets the caller avoid materialising
   * the buffer until a provider that actually needs it asks.
   */
  bytes?: Buffer | (() => Promise<Buffer>);
}

export interface ScanResult {
  verdict: ScanVerdict;
  /** AV-engine signature/threat name for an `infected` verdict (e.g.
   *  `Eicar-Test-Signature`), or a short, content-free reason for `error`
   *  (e.g. `engine_unreachable`). NEVER contains file content or PII. */
  signature?: string;
}

export interface IFileScanProvider {
  /**
   * Scan a single object. MUST resolve (never reject) on an engine/transport
   * failure — surface it as `{ verdict: 'error' }` so the caller's fail-closed
   * gate keeps the file un-servable instead of crashing the request.
   */
  scan(input: ScanInput): Promise<ScanResult>;
  healthCheck(): Promise<void>;
}

/** Resolve the `bytes` field (Buffer or lazy loader) to a Buffer, or
 *  `undefined` when no bytes were supplied. Shared helper so each provider
 *  doesn't re-implement the union handling. */
export async function resolveScanBytes(input: ScanInput): Promise<Buffer | undefined> {
  if (input.bytes === undefined) return undefined;
  return typeof input.bytes === 'function' ? input.bytes() : input.bytes;
}
