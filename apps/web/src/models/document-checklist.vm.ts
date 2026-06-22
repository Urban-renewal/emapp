/**
 * View model for the ADVISORY project document-checklist
 * (`GET /api/v1/projects/:id/document-checklist`, DH2/V13).
 *
 * The wire (`DocumentChecklist`) carries only doc-TYPE keys + present
 * booleans + counts — NO PII, NO document ids/names. The adapter resolves
 * each missing type to its Hebrew/English display label so the FE can render
 * a calm "מסמכי חובה: present מתוך total · חסר: …" line per project group.
 */
export interface DocumentChecklistMissingItem {
  /** Raw curated doc-type key (e.g. `land_registry`). */
  type: string;
  /** Resolved display label (e.g. "נסח טאבו"). */
  typeLabel: string;
}

export interface DocumentChecklistViewModel {
  projectId: string;
  presentCount: number;
  totalCount: number;
  completionPct: number;
  /** True when every required type is present (totalCount > 0). */
  isComplete: boolean;
  /** The required types still missing — drives the quiet attention chips. */
  missing: DocumentChecklistMissingItem[];
}
