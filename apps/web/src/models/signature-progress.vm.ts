/**
 * Signature-progress board ViewModel — Phase-6 "תמונת מצב" (S5a, read-only).
 *
 * The adapter (apps/web/src/adapters/project.ts → toSignatureProgressViewModel)
 * folds the wire `SignatureProgress` into this shape: raw counts pass through;
 * the bar's fill ratio + color (green when the legal threshold is met, amber
 * otherwise) are computed ONCE here so the board component stays presentational.
 * No PII is ever present (the wire carries only counts + the project's own pct).
 */
export interface SignatureProgressViewModel {
  /** Total non-archived apartments in the project. */
  totalApartments: number;
  /** Apartments where EVERY active owner has signed (binary per apartment). */
  apartmentsConsented: number;
  /** Project-scoped signed / pending signature-request counts. */
  signaturesSigned: number;
  signaturesPending: number;
  /** The project's legal consent target (%) — null when none is set. */
  targetSignaturePct: number | null;
  /** round(apartmentsConsented / totalApartments * 100); 0 when no apartments. */
  consentedPct: number;
  /** targetSignaturePct != null && consentedPct >= targetSignaturePct. */
  metThreshold: boolean;
  /** Whether a legal target is defined (drives the "no target" copy). */
  hasTarget: boolean;
  /** Bar fill color token — green once the threshold is met, amber otherwise. */
  barColor: 'green' | 'amber';
}
