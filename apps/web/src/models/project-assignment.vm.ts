/**
 * ProjectAssignment ViewModel — Phase 4c S2.
 *
 * The Wire shape (`packages/shared-types/src/project-assignment.ts`)
 * carries only IDs + lifecycle dates — no user name/email. To render
 * a meaningful list a Manager must JOIN client-side against the
 * `/members` cache (`use-members.ts`). For Agent / Viewer the BE
 * AuthorizationGuard refuses `/members` (Manager-only resource —
 * D.17), so the VM exposes both:
 *   - `name`     : human-readable label IF the lookup resolved
 *   - `email`    : same — undefined when the lookup failed (403)
 *   - `userIdShort` : 8-char hex prefix shown as a fallback so the
 *     row is still identifiable to non-Managers without leaking the
 *     full UUID (Doc 07 — no full IDs in non-essential UI surfaces).
 *
 * `active` is derived from `unassignedAt`. The BE list endpoint
 * already filters `isNull(unassignedAt)` so every visible row is
 * active today — but exposing the bit on the VM is forward-compatible
 * with a future "show inactive" toggle.
 */
export interface ProjectAssignmentViewModel {
  id: string;
  projectId: string;
  userId: string;
  userIdShort: string;
  /** Resolved name from the members cache (Manager-only enrichment). */
  name?: string;
  /** Resolved email from the members cache (Manager-only enrichment). */
  email?: string;
  /** BE default: 'agent' — kept as the raw string so a future
   *  multi-role-per-project model can extend without a wire change. */
  roleInProject: string;
  assignedAtIso: string;
  assignedRelative: string;
  active: boolean;
}
