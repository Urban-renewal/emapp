import type { ProjectStatus, ProjectType } from '@emapp/shared-types';

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
  /** Locked color palette per status — neutral / informational / positive / negative. */
  statusColor: 'gray' | 'amber' | 'emerald' | 'red';
  /** Raw status kept on the VM for branching in components / filters. */
  status: ProjectStatus;
  /** Locked-schema alignment: project rows have no description/target on the wire
   *  for new rows by default; we surface what's present, null otherwise. */
  description: string | null;
  /** D.07 — UI verb is "ארכוב" (archive), not "מחיקה". */
  isArchived: boolean;
  /** Relative timestamp (Hebrew: "לפני 3 ימים"). Falls back to ISO date past 30 days. */
  createdRelative: string;
  /** Underlying createdAt — for sorting / cursor-paired display in the list. */
  createdAtIso: string;
}
