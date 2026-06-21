import type { DocumentChecklistTrack, DocumentType } from '@emapp/shared-types';

/**
 * DH2 (V13) — the REQUIRED document-type set per renewal TRACK, for the
 * ADVISORY project document-checklist (`GET /api/v1/projects/:id/document-checklist`).
 *
 * This is a PURE, typed, tested constant — NO DB, NO PII, NO side effects. The
 * checklist service probes the `documents` table for a project-scoped doc of
 * each of these `type`s and auto-ticks `present`. It NEVER gates or mutates
 * project status (advisory only).
 *
 * ── Track derivation (the documented assumption) ──────────────────────────────
 * The project's renewal track is derived from `projects.type` (the locked
 * `project_type` enum: tama38_1 | tama38_2 | pinui_binui | other):
 *   - tama38_1, tama38_2  → 'tama38'      (both תמ"א-38 variants share one set;
 *                                           the strengthening/demolition variant
 *                                           split does not change the REQUIRED
 *                                           paperwork at this advisory granularity)
 *   - pinui_binui         → 'pinui_binui' (פינוי-בינוי — demolish-rebuild)
 *   - other (future track)→ 'default'     (the additive 'other' enum value is for
 *                                           not-yet-enumerated tracks; we fall back
 *                                           to the baseline urban-renewal set rather
 *                                           than guess a track-specific list)
 *
 * Required-set rationale (drawn from the curated `DocumentTypeEnum`):
 *   - agreement      (הסכם)        — the core signed urban-renewal agreement. Every track.
 *   - land_registry  (נסח טאבו)     — proves ownership/shares. Every track.
 *   - blueprint      (תוכנית/שרטוט)  — the planning drawings. Every track.
 *   - regulation     (תקנון/רגולציה) — pinui-binui's complex multi-building governance
 *                                      makes a תקנון a baseline expectation; the lighter
 *                                      תמ"א-38 set does not require it advisorily.
 *
 * These are ADVISORY expectations, deliberately conservative (a SMALL set the team
 * can realistically complete). Widening the set is a one-line edit here + a test
 * update; it never needs a migration.
 */
export const REQUIRED_DOC_TYPES_BY_TRACK: Readonly<
  Record<DocumentChecklistTrack, readonly DocumentType[]>
> = {
  tama38: ['agreement', 'land_registry', 'blueprint'],
  pinui_binui: ['agreement', 'land_registry', 'blueprint', 'regulation'],
  default: ['agreement', 'land_registry', 'blueprint'],
} as const;

/**
 * Map the raw `project_type` enum value to the checklist track key. Accepts a
 * plain string (the column is the closed `project_type` enum, but this stays
 * tolerant — an unknown/future value falls back to 'default' rather than throw,
 * so the advisory checklist NEVER breaks the project view).
 */
export function trackForProjectType(projectType: string): DocumentChecklistTrack {
  switch (projectType) {
    case 'tama38_1':
    case 'tama38_2':
      return 'tama38';
    case 'pinui_binui':
      return 'pinui_binui';
    default:
      return 'default';
  }
}

/**
 * The completeness percentage for an advisory checklist: round(present/total*100).
 * Defensive: 0 required types → 0% (avoids a divide-by-zero; no track is empty today).
 */
export function checklistCompletionPct(presentCount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.round((presentCount / totalCount) * 100);
}
