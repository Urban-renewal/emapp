import type {
  ProjectStatus,
  ProjectType,
  RelocationType,
  SignatureMilestone,
} from '@emapp/shared-types';

/**
 * Project ViewModel — what list rows / detail cards render. Adapter
 * (apps/web/src/adapters/project.ts) folds the wire `Project` into
 * this shape; components consume the VM exclusively.
 *
 * Per docs/05 §9.8: every label / color / computed field lives in the
 * adapter so a future wire-schema change doesn't ripple through pages.
 */
export interface ProjectViewModel {
  /** Verbatim from wire. */
  id: string;
  /** Verbatim from wire — `Project.name` (1-200 chars). */
  name: string;
  /** Hebrew display label for `Project.type` (D.18-style enum mapping). */
  typeLabel: string;
  /** Raw type kept on the VM for branching in components (e.g. icons). */
  type: ProjectType;
  /** Hebrew display label for `Project.status` (D.18 LAW). */
  statusLabel: string;
  /** Locked semantic intent per status — neutral / informational / positive / negative. */
  intent: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** Raw status kept on the VM for branching in components / filters. */
  status: ProjectStatus;
  /** Required owner-CONSENT threshold (%) for this project — defaulted from the
   *  urban-renewal track (the type) at create, overridable per project. Makes
   *  the type FUNCTIONAL: it sets the legal majority the project must reach.
   *  null only for legacy rows created before the default existed. */
  targetConsentPct: number | null;
  /** Owner-approved staged overlay (Gate-6, Option A) — ordered intermediate
   *  signature targets under the legal consent gate, used to render tick marks
   *  on the signature-progress bar. Empty array when none / null on the wire. */
  signatureMilestones: SignatureMilestone[];
  /** Locked-schema alignment: project rows have no description/target on the wire
   *  for new rows by default; we surface what's present, null otherwise. */
  description: string | null;
  /** P3 create-form enrichment (migration 0062) — all nullable. The developer
   *  (יזם) executing the project, often distinct from the managing org. */
  developerName: string | null;
  developerCompanyId: string | null;
  /** Owner-compensation basics (תמורה) — existing vs planned unit counts (the
   *  expansion) + an optional extra-area figure. All nullable. */
  existingUnits: number | null;
  plannedUnits: number | null;
  extraAreaSqm: number | null;
  /** Relocation arrangement (פינוי) for demolish-rebuild tracks. Raw enum +
   *  free-text notes; both nullable. The Hebrew label is resolved in the
   *  component via i18n (not the adapter — it's a small open set, not a locked
   *  D.18 mapping). */
  relocationType: RelocationType | null;
  relocationNotes: string | null;
  /** Human name of a future renewal track when `type === 'other'` (raw wire
   *  `typeLabel`). Distinct from the display `typeLabel` above, which is the
   *  resolved Hebrew/label string. Null unless the project is 'other'. */
  futureTrackLabel: string | null;
  /** Parcel provenance (גוש-חלקה) — the project site's lead land-registration
   *  identity. Distinct from the per-building block/parcel. All nullable. */
  block: string | null;
  parcel: string | null;
  subparcel: string | null;
  /** D.07 — UI verb is "ארכוב" (archive), not "מחיקה". */
  isArchived: boolean;
  /** Relative timestamp (Hebrew: "לפני 3 ימים"). Falls back to ISO date past 30 days. */
  createdRelative: string;
  /** Underlying createdAt — for sorting / cursor-paired display in the list. */
  createdAtIso: string;
  /**
   * Aggregate counts attached to list/detail rows by the BE since the
   * project stats slice (resolves doc-debt: "stats depend on Phase 5
   * signatures"). Optional because the wire `Project` schema (used by
   * write responses) doesn't carry them — only `ProjectListItem` does.
   * Components show "—" when undefined.
   */
  buildingsCount?: number;
  unitsCount?: number;
  signaturesPendingCount?: number;
  signaturesSignedCount?: number;
  agentsCount?: number;
}
