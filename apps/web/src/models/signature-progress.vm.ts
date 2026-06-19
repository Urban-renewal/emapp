/**
 * Signature-progress board ViewModel — Phase-6 "תמונת מצב" (S5a, read-only).
 *
 * The adapter (apps/web/src/adapters/project.ts → toSignatureProgressViewModel)
 * folds the wire `SignatureProgress` into this shape: raw counts pass through;
 * the bar's fill ratio + color (green when the legal threshold is met, amber
 * otherwise) are computed ONCE here so the board component stays presentational.
 * No PII is ever present (the wire carries only counts + the project's own pct).
 */
import type { ConsentBasis } from '@emapp/shared-types';

export interface SignatureProgressViewModel {
  /** Total non-archived apartments in the project. */
  totalApartments: number;
  /** Apartments FULLY consented (every active owner signed) — display count
   *  only; NO LONGER the basis of `consentedPct` (which is share-weighted). */
  apartmentsConsented: number;
  /** Project-scoped signed / pending signature-request counts. */
  signaturesSigned: number;
  signaturesPending: number;
  /** The project's legal consent target (%) — null when none is set. */
  targetSignaturePct: number | null;
  /** E2 Wave-1 B0 — SHARE-WEIGHTED headline consent %: round(Σ per-apartment
   *  signed-share contributions / totalApartments * 100); 0 when no apartments. */
  consentedPct: number;
  /** targetSignaturePct != null && consentedPct >= targetSignaturePct. */
  metThreshold: boolean;
  /** Whether a legal target is defined (drives the "no target" copy). */
  hasTarget: boolean;
  /** Bar fill color token — green once the threshold is met, amber otherwise. */
  barColor: 'green' | 'amber';
  /** The consent-% computation basis (always 'share' today). The board renders
   *  the mandatory basis label from this so the % is never a bare percent. */
  basis: ConsentBasis;
}
