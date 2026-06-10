import type { IFileScanProvider, ScanInput, ScanResult } from './scan.interface';

/**
 * Dev/test file scanner — ALWAYS returns `clean` (mirrors NoopSMSProvider).
 *
 * Rationale: with no AV engine wired in dev/test, gating downloads on a real
 * verdict would make EVERY uploaded document un-downloadable and break the
 * upload→finalize→download flow + its specs. Noop unblocks those flows by
 * attesting `clean` — and logs (to stderr, key only, NEVER file bytes) so it
 * is obvious in dev that no real scanning happened.
 *
 * It is dev/test ONLY: `scanProviderFactory` refuses to select it in
 * production (fail-fast), exactly like NoopSMSProvider under D.20.
 */
export class NoopFileScanProvider implements IFileScanProvider {
  async scan(input: ScanInput): Promise<ScanResult> {
    process.stderr.write(
      `[NoopFileScanProvider] file NOT scanned — noop active. key=${input.key} verdict=clean\n`,
    );
    return { verdict: 'clean' };
  }

  async healthCheck(): Promise<void> {}
}
