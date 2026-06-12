import type {
  ExtractionInput,
  ExtractionResult,
  ExtractionRow,
  IExtractionProvider,
} from './extraction.interface';

/**
 * StubExtractionProvider — the DEFAULT engine (no creds → this). DETERMINISTIC,
 * makes NO network call, NO PII leaves the process. It parses the simple
 * line-oriented format `name|nationalId|num/den` (one owner per line) out of the
 * input text (or a utf-8 decode of the bytes). Blank lines + malformed lines are
 * skipped. engineId = 'stub'.
 *
 * This is the dev/test stand-in for the real (Gemini / Claude vision) engine —
 * it lets the whole 7b parse→encrypt→store pipeline run end-to-end offline. A
 * real engine plugs in behind IExtractionProvider via extractionProviderFactory.
 */
export class StubExtractionProvider implements IExtractionProvider {
  readonly engineId = 'stub' as const;

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const text = input.text ?? input.bytes.toString('utf8');
    const rows: ExtractionRow[] = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const name = parts[0]?.trim();
      const nationalId = parts[1]?.trim();
      const share = parts[2]?.trim() ?? '';
      const [numStr, denStr] = share.split('/');
      const shareNumerator = numStr !== undefined ? Number(numStr.trim()) : undefined;
      const shareDenominator = denStr !== undefined ? Number(denStr.trim()) : undefined;
      rows.push({
        name: name || undefined,
        nationalId: nationalId || undefined,
        shareNumerator: Number.isFinite(shareNumerator) ? shareNumerator : undefined,
        shareDenominator: Number.isFinite(shareDenominator) ? shareDenominator : undefined,
        // The stub is a deterministic exact parse → full confidence.
        confidence: 1,
      });
    }
    return { rows, rawText: text, engineId: this.engineId };
  }
}
