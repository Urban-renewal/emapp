/**
 * IExtractionProvider — the pluggable seam for parsing a Tabu (נסח טאבו) source
 * document into owner/share rows (Slice 7b-extract). Mirrors the ISMSProvider /
 * IStorageProvider DI-token-and-factory pattern: the DEFAULT is a deterministic
 * Stub that makes NO external call (NO PII leaves the process); a real engine
 * (Gemini / Claude vision) plugs in later behind the same interface, selected by
 * `extractionProviderFactory()` when its env creds are present.
 *
 * SECURITY: implementations MUST treat the input bytes/text as PII (name +
 * national_id appear verbatim) — never log the content, never echo it in errors.
 * The Stub does NOT transmit anything off-process.
 */

/** A single owner/share row the engine parsed off the source נסח. */
export interface ExtractionRow {
  /** Owner full name (PII). Optional — a partial parse may miss it. */
  name?: string;
  /** Owner national_id (PII). Optional — a partial parse may miss it. */
  nationalId?: string;
  /** Ownership share fraction numerator (e.g. 1 of 1/2). Optional. */
  shareNumerator?: number;
  /** Ownership share fraction denominator (e.g. 2 of 1/2). Optional. */
  shareDenominator?: number;
  /** Engine confidence in [0,1] for this row. */
  confidence: number;
}

/** The raw input handed to the engine: the source object's bytes + its declared
 *  mime type, plus an OPTIONAL pre-decoded text view (the service passes the
 *  utf-8 decode so a text-based engine/Stub need not re-decode). */
export interface ExtractionInput {
  bytes: Buffer;
  mimeType: string;
  text?: string;
}

/** The engine output: the parsed rows + the (optional) full raw text it read
 *  (the service ENCRYPTS this at rest — it embeds PII) + the engineId that
 *  produced the result (stamped on the extraction for provenance). */
export interface ExtractionResult {
  rows: ExtractionRow[];
  rawText?: string;
  engineId: string;
}

export interface IExtractionProvider {
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
