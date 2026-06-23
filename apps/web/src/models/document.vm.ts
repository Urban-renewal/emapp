import type { DocumentScanStatus } from '@emapp/shared-types';

export interface DocumentViewModel {
  id: string;
  name: string;
  /** Free text on the BE (seeds/imports use agreement/blueprint/regulation);
   *  `typeLabel` is the resolved Hebrew/English display string. */
  type: string;
  typeLabel: string;
  mimeType: string;
  sizeBytes: number;
  /** Human-readable size — "1.2 MB" / "523 KB" / "84 B". */
  sizeLabel: string;
  isArchived: boolean;
  createdRelative: string;
  projectId: string | null;
  apartmentId: string | null;
  // ── DOCUMENTS-REMEDIATION-PLAN Phase 1 — fields the Phase-2 detail card needs.
  // All NON-PII (a processing flag / org-internal parent labels).
  /** PII-bearing-by-type / opt-in step-up flag (drives the "רגיש" badge + the
   *  step-up download path). The flag itself is not owner PII. */
  isSensitive: boolean;
  /** Raw AV scan state ('pending'|'clean'|'infected'|'error') — for badge logic. */
  scanStatus: DocumentScanStatus;
  /** Localized AV-scan label (HE/EN) the card can render directly. */
  scanStatusLabel: string;
  /** True only for scanStatus==='clean' (the only servable state) — lets the UI
   *  show a calm "ready" affordance vs a "still processing / blocked" one. */
  isScanClean: boolean;
  /** Resolved parent project NAME (org-internal label, NOT owner PII), or null
   *  when there is no project parent / the producer didn't resolve it. */
  projectName: string | null;
  /** Resolved parent apartment NUMBER (org-internal label), or null. */
  apartmentName: string | null;
}
