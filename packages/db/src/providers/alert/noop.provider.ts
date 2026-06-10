import type { AlertEvent, IAlertSink } from './alert.interface';

/**
 * Dev/test alert sink — does not page anyone.
 *
 * In `test` it is silent (keeps suite output clean) but still records the
 * last event in-memory so a unit test can assert "the detector fired with
 * this severity/kind/meta" without a real channel. In `development` it
 * writes one stderr line so a developer can SEE a breach alert would have
 * gone out. Never throws (fail-safe guarantee).
 */
export class NoopAlertSink implements IAlertSink {
  /** Last event seen — test-only inspection hook, never read in prod. */
  public lastEvent: AlertEvent | undefined;
  /** All events seen this process — bounded by the caller's usage in tests. */
  public readonly events: AlertEvent[] = [];

  private readonly verbose: boolean;

  constructor(opts?: { verbose?: boolean }) {
    this.verbose = opts?.verbose ?? process.env['NODE_ENV'] !== 'test';
  }

  async alert(event: AlertEvent): Promise<void> {
    this.lastEvent = event;
    this.events.push(event);
    if (!this.verbose) return;
    try {
      const meta = event.meta ? ` ${JSON.stringify(event.meta)}` : '';
      process.stderr.write(
        `[NoopAlertSink] ${event.severity.toUpperCase()} ${event.kind}: ${event.summary}${meta}\n`,
      );
    } catch {
      // fail-safe: a logging hiccup must never propagate to the caller.
    }
  }
}
