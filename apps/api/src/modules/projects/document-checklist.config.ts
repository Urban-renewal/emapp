/**
 * DH2 (V13) — the ADVISORY project document-checklist config.
 *
 * The REQUIRED document-type set per renewal TRACK and the track-derivation from
 * `project_type` now live in `@emapp/shared-types` (the FE/BE contract) so BOTH
 * the BE checklist endpoint AND the FE party-binder completeness read ONE
 * definition — no second copy to drift. This module RE-EXPORTS them (preserving
 * the existing BE import sites + spec) and keeps the FE-irrelevant completeness
 * math (`checklistCompletionPct`) local.
 *
 * Still a PURE, typed, tested module — NO DB, NO PII, NO side effects. The
 * checklist service probes the `documents` table for a project-scoped doc of
 * each required `type` and auto-ticks `present`; it NEVER gates or mutates
 * project status (advisory only).
 */
export { REQUIRED_DOC_TYPES_BY_TRACK, trackForProjectType } from '@emapp/shared-types';

/**
 * The completeness percentage for an advisory checklist: round(present/total*100).
 * Defensive: 0 required types → 0% (avoids a divide-by-zero; no track is empty today).
 */
export function checklistCompletionPct(presentCount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.round((presentCount / totalCount) * 100);
}
