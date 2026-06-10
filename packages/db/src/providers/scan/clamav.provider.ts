import { connect, type Socket } from 'node:net';

import {
  resolveScanBytes,
  type IFileScanProvider,
  type ScanInput,
  type ScanResult,
} from './scan.interface';

/**
 * Config for the ClamAV (`clamd`) daemon. Supplied at construction by the
 * app-side factory from Infisical-injected env — NEVER hard-coded
 * (Gate-4 SECRETS LAW).
 */
export interface ClamAvScanConfig {
  /** `clamd` host (e.g. an internal Railway service / sidecar address). */
  host: string;
  /** `clamd` TCP port (clamd default 3310). */
  port: number;
  /** Per-scan socket timeout (ms). A scan that overruns ⇒ `error` (fail-closed,
   *  the file stays un-servable). Defaults to 30s. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the real `node:net` connector. */
  connectImpl?: (port: number, host: string) => Socket;
}

/**
 * ClamAV (`clamd`) implementation of `IFileScanProvider` (P0.B1 — anti-malware
 * on uploaded documents).
 *
 * ⚠️ VERIFY-BEFORE-GO-LIVE: this targets clamd's documented `zINSTREAM`
 * command (NUL-terminated `zINSTREAM\0`, then length-prefixed chunks, then a
 * zero-length terminator; reply `stream: OK` ⇒ clean, `... FOUND` ⇒ infected,
 * anything else ⇒ error). Confirm against your clamd version + that
 * `StreamMaxLength` ≥ the document size ceiling (50 MB) before flipping the
 * provider on in prod. The wire protocol is isolated in {@link buildInstream}
 * / {@link parseReply} so swapping to a different engine (or an HTTP AV gateway)
 * is a one-method change, not a rewrite — mirroring InforuSmsProvider.
 *
 * FAIL-CLOSED: any connection / timeout / protocol error resolves to
 * `{ verdict: 'error' }` (never throws, never a false `clean`). The caller's
 * gate treats `error` as NOT downloadable.
 *
 * PRIVACY: the file bytes are streamed to the daemon but NEVER logged; only the
 * object key and the AV signature label are ever surfaced.
 */
export class ClamAvFileScanProvider implements IFileScanProvider {
  private readonly timeoutMs: number;
  private readonly connectImpl: (port: number, host: string) => Socket;

  constructor(private readonly config: ClamAvScanConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.connectImpl = config.connectImpl ?? ((port, host) => connect(port, host));
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const bytes = await resolveScanBytes(input).catch(() => undefined);
    if (bytes === undefined) {
      // No bytes to scan: this provider needs the object content (it does not
      // fetch out-of-band). Treat as error (fail-closed) — the file is NOT
      // attested clean, so it stays un-servable.
      return { verdict: 'error', signature: 'no_bytes_supplied' };
    }

    let reply: string;
    try {
      reply = await this.sendInstream(bytes);
    } catch (err) {
      // Connection refused / timeout / socket error — fail-closed.
      return {
        verdict: 'error',
        signature: err instanceof Error ? sanitizeReason(err.message) : 'scan_error',
      };
    }
    return parseReply(reply);
  }

  async healthCheck(): Promise<void> {
    // clamd exposes `zPING` → `PONG`; a deeper check is left to the deploy
    // probe. Connectivity errors otherwise surface on the first scan and are
    // mapped to an `error` verdict (fail-closed).
  }

  /**
   * Open a socket, stream the `zINSTREAM` request, resolve with the daemon's
   * single-line reply. Rejects on any transport/timeout failure (mapped to
   * `error` by the caller).
   */
  private sendInstream(bytes: Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = this.connectImpl(this.config.port, this.config.host);
      const chunks: Buffer[] = [];
      let settled = false;

      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        fn();
      };

      socket.setTimeout(this.timeoutMs);
      socket.on('timeout', () => done(() => reject(new Error('scan_timeout'))));
      socket.on('error', (e: Error) => done(() => reject(e)));
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.on('end', () => done(() => resolve(Buffer.concat(chunks).toString('utf8').trim())));
      socket.on('connect', () => {
        try {
          socket.write(buildInstream(bytes));
        } catch (e) {
          done(() => reject(e instanceof Error ? e : new Error('write_error')));
        }
      });
    });
  }
}

/** clamd INSTREAM framing: `zINSTREAM\0`, then for each chunk a 4-byte
 *  big-endian length prefix + the chunk, terminated by a zero-length chunk.
 *  Isolated swap point (engine/protocol revision). */
export function buildInstream(bytes: Buffer): Buffer {
  const CHUNK = 64 * 1024;
  const parts: Buffer[] = [Buffer.from('zINSTREAM\0', 'ascii')];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(slice.length, 0);
    parts.push(len, slice);
  }
  const terminator = Buffer.allocUnsafe(4);
  terminator.writeUInt32BE(0, 0);
  parts.push(terminator);
  return Buffer.concat(parts);
}

/** Isolated, engine-specific reply parser (swap point).
 *  clamd: `stream: OK` ⇒ clean; `stream: <Sig> FOUND` ⇒ infected;
 *  `... ERROR` or anything unrecognised ⇒ error (fail-closed). */
export function parseReply(reply: string): ScanResult {
  const line = reply.replace(/\0/g, '').trim();
  if (/\bOK$/.test(line)) return { verdict: 'clean' };
  if (/\bFOUND$/.test(line)) {
    // `stream: Eicar-Test-Signature FOUND` → signature label only (no content).
    const match = /:\s*(.+?)\s+FOUND$/.exec(line);
    return { verdict: 'infected', signature: match?.[1] ?? 'unknown_signature' };
  }
  return { verdict: 'error', signature: sanitizeReason(line) || 'unknown_reply' };
}

/** Keep a reason label short + content-free (never let arbitrary bytes or a
 *  long daemon string flow into logs/results). */
function sanitizeReason(reason: string): string {
  return reason.replace(/[^\w .:-]/g, '').slice(0, 80);
}
