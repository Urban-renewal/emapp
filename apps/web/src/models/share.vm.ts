/**
 * Share ViewModel — Phase 4f.
 *
 * Contractor↔Project access grants with a strict JSONB permissions
 * shape (see SharePermissionsSchema in shared-types/share.ts).
 *
 * D.17: read=ALL, create/update/delete=MGR.
 *
 * The wire `permissions` shape is .strict() at every level — unknown
 * keys are rejected, never silently dropped. The VM exposes a
 * pre-computed `permissionSummary` (count of "on" toggles) so the
 * list view can render a compact badge without re-walking the tree.
 */
import type { SharePermissions } from '@emapp/shared-types';

export interface ShareViewModel {
  id: string;
  projectId: string;
  contractorId: string;
  /** 8-char hex prefix for the contractor id — fallback when the
   *  contractor lookup isn't resolved (or returns nothing). */
  contractorIdShort: string;
  /** Resolved name when the caller has /contractors visibility AND
   *  the contractor record still exists. Undefined otherwise. */
  contractorName?: string;
  permissions: SharePermissions;
  /** "3 / 6" — how many top-level sections are turned `on`. */
  permissionSummary: string;
  /** True when revokedAt is set; the BE filters revoked rows out of
   *  the list endpoint, but the detail / patch path can still reach
   *  one if the row was revoked between fetch and edit. */
  isRevoked: boolean;
  lastAccessedAtIso: string | null;
  lastAccessedRelative: string | null;
  createdAtIso: string;
  createdRelative: string;
}

/** Helper exported for the share form — counts the top-level "on"
 *  toggles (overview/tenants/documents/signatures/notes/team).
 *  Pure; same value the adapter writes to `permissionSummary`. */
export function countActiveSections(perms: SharePermissions): number {
  return [
    perms.overview.on,
    perms.tenants.on,
    perms.documents.on,
    perms.signatures.on,
    perms.notes.on,
    perms.team.on,
  ].filter(Boolean).length;
}

/**
 * D.46 — the default permission set the contractor share form starts from.
 * Mirrors the BE `defaultSharePermissions()` (kept in sync):
 *  - overview ON, signature PROGRESS ON (aggregate-only)
 *  - OWNERS / PII (`tenants`) OFF — never by default
 *  - documents OFF (manager-selected)
 *  - notes / team OFF
 */
export const SHARE_DEFAULT_PERMISSIONS: SharePermissions = {
  overview: { on: true },
  tenants: {
    on: false,
    fields: { name: true, phone: false, email: false, national_id: false, note: false },
  },
  documents: { on: false, actions: { download: true, upload: false } },
  signatures: { on: true },
  notes: { on: false },
  team: { on: false },
};
