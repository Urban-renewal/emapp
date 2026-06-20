/**
 * Per-apartment signature-progress drill-down ViewModel — Phase-6 "תמונת מצב"
 * (S5d, read-only). Sits under the S5a board.
 *
 * The adapter (apps/web/src/adapters/project.ts →
 * toApartmentSignatureProgressViewModels) folds each wire
 * `ApartmentSignatureProgress` row into this shape: counts pass through; the
 * human designation ("דירה {number} · קומה {floor}" when a floor is present,
 * else "דירה {number}") and the status chip intent (success=consented /
 * warning=partial / neutral=none) are computed ONCE here so the component stays
 * presentational. No PII is ever present (the wire carries only the apartment
 * designation + counts + status).
 */
export interface ApartmentSignatureProgressViewModel {
  /** apartments.id — stable React key. */
  apartmentId: string;
  /** Raw apartment number/label (already bidi-safe — system-controlled). */
  number: string;
  /** Apartment floor, or null when unknown. */
  floor: number | null;
  /** Active owner ownerships on the apartment. */
  totalOwners: number;
  /** Of those, the owners holding a signed request on a project document. */
  signedOwners: number;
  /** Ternary consent status for this apartment. */
  status: 'consented' | 'partial' | 'none';
  /** "דירה {number} · קומה {floor}" or "דירה {number}" when floor is null. */
  designation: string;
  /** Status chip intent — success=consented, warning=partial, neutral=none. */
  intent: 'success' | 'warning' | 'neutral';
}

/**
 * E2 Wave-2 E2.2-S3 / B4 — apartment HOLDOUT ViewModel ("מי תקוע / who's stuck").
 *
 * One active owner of an apartment who has NOT signed. This is the ONLY
 * signature-progress shape that carries owner PII (the NAME), so it is loaded
 * ON DEMAND from the `view_owner_pii`-gated + audited B4 endpoint — never eagerly
 * for the whole board. The adapter bidi-strips the name; the component still
 * wraps it in `<NameDisplay>` at render (§v9-H-3 defense in depth). `national_id`
 * and `phone` are NEVER present.
 */
export interface ApartmentHoldoutViewModel {
  /** owners.id — stable React key. */
  ownerId: string;
  /** Owner display name (bidi-stripped). Null for a named-less shell owner. */
  name: string | null;
  /** The apartment's number/label (system-controlled, bidi-stripped). */
  apartmentNumber: string;
}
