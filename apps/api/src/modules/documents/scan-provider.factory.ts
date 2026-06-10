import { ClamAvFileScanProvider, NoopFileScanProvider, type IFileScanProvider } from '@emapp/db';

/** DI token for the file anti-malware scanner (P0.B1). Mirrors
 *  `STORAGE_PROVIDER` / the SMS `SMS_PROVIDER` seam — the concrete class is
 *  chosen ONCE here; the service injects the interface. */
export const FILE_SCAN_PROVIDER = 'FILE_SCAN_PROVIDER';

/**
 * File-scan provider selection (P0.B1) — mirrors `smsProviderFactory` and
 * `storageProviderFactory` (the same GOVERNED pattern as D.20 / D.27).
 *
 * Uploaded documents are served to residents via presigned URLs, so an
 * unscanned file makes EMAPP a malware vector. The download gate refuses any
 * document that is not scanned-`clean` (fail-closed). Selection:
 *
 *   - If a real engine is configured (`FILE_SCAN_CLAMAV_HOST` [+ optional
 *     `_PORT`]) → use the real `ClamAvFileScanProvider`, in ANY env. This is
 *     the single config-swap point: provision the host/port in Infisical
 *     (Gate-4 SECRETS LAW) and confirm the clamd protocol/`StreamMaxLength`
 *     in `clamav.provider.ts` before go-live.
 *   - Else in PRODUCTION → FAIL FAST at boot. A prod deploy must never serve
 *     documents with NO real malware scanning (that is the exact prod risk
 *     P0.B1 closes). NoopFileScanProvider attests `clean` for everything.
 *   - Else (dev / test / unset) → `NoopFileScanProvider` (logs, scans nothing,
 *     returns `clean` so the upload→finalize→download flow + specs are
 *     unblocked).
 *
 * The token name `FILE_SCAN_PROVIDER` stays the DI seam
 * (documents.service.ts); only the concrete class changes here.
 */
export function scanProviderFactory(): IFileScanProvider {
  const host = process.env['FILE_SCAN_CLAMAV_HOST'];
  const port = Number(process.env['FILE_SCAN_CLAMAV_PORT'] ?? '3310');
  const timeoutMs = process.env['FILE_SCAN_TIMEOUT_MS']
    ? Number(process.env['FILE_SCAN_TIMEOUT_MS'])
    : undefined;

  if (host && Number.isFinite(port) && port > 0) {
    return new ClamAvFileScanProvider({ host, port, timeoutMs });
  }

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'FILE_SCAN_PROVIDER: refusing to boot — production requires a real malware ' +
        'scanner (P0.B1). NoopFileScanProvider attests every file as clean, which ' +
        'would make EMAPP a malware-distribution vector (owners upload → residents ' +
        'download). Provision FILE_SCAN_CLAMAV_HOST (+ FILE_SCAN_CLAMAV_PORT) in ' +
        'Infisical and confirm the clamd protocol in clamav.provider.ts before deploying.',
    );
  }

  return new NoopFileScanProvider();
}
