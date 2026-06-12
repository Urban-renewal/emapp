import { StubExtractionProvider, type IExtractionProvider } from '@emapp/db';

/**
 * EXTRACTION_PROVIDER — the DI seam (mirrors SMS_PROVIDER / STORAGE_PROVIDER /
 * FILE_SCAN_PROVIDER). The token name stays fixed; only the concrete class
 * resolved by `extractionProviderFactory` changes when a real engine is
 * provisioned. Injected positionally into TabuExtractionsService.
 */
export const EXTRACTION_PROVIDER = 'EXTRACTION_PROVIDER';

/**
 * Tabu-extraction engine selection (Slice 7b-extract) — the single config-swap
 * point for the pluggable parse engine, GOVERNED exactly like the SMS / storage
 * / scan factories.
 *
 *   - If a real engine's creds are present (e.g. a future
 *     `EXTRACTION_ENGINE=gemini` + `GEMINI_API_KEY`, or a Claude vision key) →
 *     return that engine. This is where the real (Gemini / Claude) provider
 *     plugs in — provision the creds in Infisical and instantiate it here.
 *   - Else (dev / test / unset) → `StubExtractionProvider` — a DETERMINISTIC
 *     parse of the `name|nationalId|num/den` line format that makes NO external
 *     call (NO PII leaves the process). engineId = 'stub'.
 *
 * NOTE: unlike SMS/storage, the Stub is a fully-functional offline default (it
 * really parses), so there is NO production fail-fast here — a deploy without an
 * AI engine simply uses the deterministic Stub. When a real engine is added,
 * mirror the SMS factory's `if (process.env.NODE_ENV === 'production') throw`
 * guard if a no-op default ever becomes undeliverable.
 */
export function extractionProviderFactory(): IExtractionProvider {
  // Seam for the real engine. When EXTRACTION_ENGINE + its creds are provisioned
  // in Infisical, branch here to `new GeminiExtractionProvider({...})` etc.
  // const engine = process.env['EXTRACTION_ENGINE'];
  // if (engine === 'gemini' && process.env['GEMINI_API_KEY']) { ... }

  return new StubExtractionProvider();
}
