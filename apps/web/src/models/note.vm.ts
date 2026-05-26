/**
 * Note ViewModel — Phase 4e.
 *
 * Org-scoped notes optionally attached to a project or apartment.
 * D.17: read=ALL, create=MA (Manager+Agent), update/delete=MA with
 * service-layer author check (only Manager OR the original author can
 * edit/delete; Viewer is read-only on every action).
 */
export interface NoteViewModel {
  id: string;
  organizationId: string;
  projectId: string | null;
  apartmentId: string | null;
  body: string;
  pinned: boolean;
  isArchived: boolean;
  createdBy: string;
  /** 8-char hex prefix — used as the "by user N" fallback when no
   *  member lookup is available (Agent/Viewer can't load /members). */
  createdByShort: string;
  /** Resolved when caller is Manager (members.list succeeds). */
  createdByName?: string;
  createdAtIso: string;
  createdRelative: string;
  updatedAtIso: string;
  updatedRelative: string;
}
