/**
 * Document upload — the PURE confidence-band logic for the generic scope-aware
 * dropzone (S3). Given the EXISTING `POST /documents/classify` ranked
 * suggestions, decide how much the human is asked:
 *
 *   - AUTO    (top confidence ≥ 0.85) — the system is sure. SILENTLY file as the
 *             top type, show "שויך כ-{type} · בטל" (one-click undo). EXCEPTION:
 *             a SENSITIVE-by-type top suggestion NEVER auto-files — it pauses for
 *             the encrypt notice (see `bandFor`), even at AUTO confidence.
 *   - CONFIRM (0.5 ≤ top < 0.85) — pre-select the top suggestion; "שינוי" opens
 *             the GAPS-HERE list (the scope's missing required types), not all 19.
 *   - ASK     (top < 0.5, or no suggestion fired) — offer the "חסר כאן" missing
 *             types first, then "אחר".
 *
 * This is the SINGLE source of truth for the band decision (FE-only; the
 * classifier itself is the BE's canonical seam — we only INTERPRET its output).
 * Pure + deterministic so it is unit-testable without React (this package ships
 * no @testing-library/react — see project-document-upload.spec.ts).
 */
import {
  isSensitiveDocType,
  type ClassifyResult,
  type ClassifySuggestion,
  type DocumentType,
} from '@emapp/shared-types';

/** Top suggestion at/above this confidence → AUTO-file (unless sensitive). */
export const AUTO_CONFIDENCE = 0.85;
/** Top suggestion in [CONFIRM_CONFIDENCE, AUTO_CONFIDENCE) → pre-select + confirm. */
export const CONFIRM_CONFIDENCE = 0.5;

export type ClassifyBand = 'auto' | 'confirm' | 'ask';

export interface BandDecision {
  band: ClassifyBand;
  /** The top-ranked suggested type (the AUTO/CONFIRM pre-selection), or null when
   *  no suggestion fired (ASK with no pre-selection). */
  suggestedType: DocumentType | null;
  /** The top suggestion's confidence (0..1), or 0 when none fired. */
  confidence: number;
  /** True when the resolved type is SENSITIVE-by-type — the upload MUST pause for
   *  the encrypt notice (content-upload path) regardless of the band. */
  sensitive: boolean;
}

/**
 * Decide the band from a classify result. The classifier returns suggestions
 * ranked DESC by confidence (best first); an EMPTY list means no signal fired.
 *
 * SENSITIVE OVERRIDE: if the top suggestion is a sensitive-by-type doc, the band
 * is DOWNGRADED from `auto` to `confirm` so the user always sees + acknowledges
 * the encrypt notice before the (content-path) upload — a tabu/ID/financial is
 * never silently auto-filed. CONFIRM/ASK already pause, so they are unchanged.
 */
export function decideBand(result: ClassifyResult): BandDecision {
  const top: ClassifySuggestion | undefined = result.suggestions[0];
  if (!top) {
    return { band: 'ask', suggestedType: null, confidence: 0, sensitive: false };
  }
  const sensitive = isSensitiveDocType(top.docType);
  let band: ClassifyBand;
  if (top.confidence >= AUTO_CONFIDENCE) band = 'auto';
  else if (top.confidence >= CONFIRM_CONFIDENCE) band = 'confirm';
  else band = 'ask';
  // Sensitive-by-type NEVER auto-files: downgrade AUTO → CONFIRM so the encrypt
  // notice is always shown + acknowledged. (confirm/ask already pause.)
  if (band === 'auto' && sensitive) band = 'confirm';
  return { band, suggestedType: top.docType, confidence: top.confidence, sensitive };
}
