/**
 * Enterprise IAM — the permission catalog (CODE, typed const).
 *
 * IAM-DESIGN §2. This is Layer 1 of the three-layer model (§1): the atomic
 * actions the app can check. It lives in CODE (not the DB) because each
 * permission binds to a real enforcement point — you cannot invent one
 * without a code change. Roles (Layer 2) + assignments (Layer 3) live in the
 * DB and reference these strings.
 *
 * SLICE 1 NOTE — PURELY ADDITIVE. This module is the catalog ONLY. It is the
 * vocabulary the seeded `role_permissions` rows draw from and the contract the
 * future `PermissionService.can()` (a later slice) will enforce. NOTHING in
 * this slice reads this file at request time — `policy.ts` is still the live
 * enforcement engine and is intentionally untouched. The pinning test
 * (`permissions.spec.ts`) is the drift alarm.
 *
 * `*` (in the design table) = read · create · update · archive. We expand it
 * to discrete strings here so every permission is a real, grantable atom.
 */

/**
 * The full permission catalog — IAM-DESIGN §2. Every string here is a discrete,
 * grantable permission. Order is grouped-by-resource for readability; the
 * pinning test asserts the SET, not the order.
 */
export const PERMISSIONS = [
  // ── projects · buildings · apartments : `*` ──────────────────────────────
  'projects.read',
  'projects.create',
  'projects.update',
  'projects.archive',
  'buildings.read',
  'buildings.create',
  'buildings.update',
  'buildings.archive',
  'apartments.read',
  'apartments.create',
  'apartments.update',
  'apartments.archive',

  // ── owners : `*` + reveal_pii (discrete, audited cleartext access) ────────
  'owners.read',
  'owners.create',
  'owners.update',
  'owners.archive',
  'owners.reveal_pii',

  // ── ownerships : read, set (atomic 100%, D.25) ───────────────────────────
  'ownerships.read',
  'ownerships.set',

  // ── documents : `*` + download ; signature_requests : read, send, cancel ─
  'documents.read',
  'documents.create',
  'documents.update',
  'documents.archive',
  'documents.download',
  'signature_requests.read',
  'signature_requests.send',
  'signature_requests.cancel',

  // ── tasks · notes · contractors : `*` ; shares : create, revoke ──────────
  'tasks.read',
  'tasks.create',
  'tasks.update',
  'tasks.archive',
  'notes.read',
  'notes.create',
  'notes.update',
  'notes.archive',
  'contractors.read',
  'contractors.create',
  'contractors.update',
  'contractors.archive',
  'shares.create',
  'shares.revoke',

  // ── imports : read, run, cancel, map ; mapping_templates : read, manage ──
  'imports.read',
  'imports.run',
  'imports.cancel',
  'imports.map',
  'mapping_templates.read',
  'mapping_templates.manage',

  // ── export : run (bulk data leaves system — gated + audited) ─────────────
  'export.run',

  // ── stats : read ; audit : read ──────────────────────────────────────────
  'stats.read',
  'audit.read',

  // ── members : read, invite, update, remove ; roles : read, assign, revoke, manage ─
  'members.read',
  'members.invite',
  'members.update',
  'members.remove',
  'roles.read',
  'roles.assign',
  'roles.revoke',
  'roles.manage',

  // ── org administration (Owner/Admin tier) ────────────────────────────────
  'org.settings.read',
  'org.settings.update',
  'org.security_policy.manage',
  'org.billing.manage',
  'org.transfer_ownership',
  'org.delete',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** O(1) membership check + the source of truth for "is this a real permission?". */
export const PERMISSION_SET: ReadonlySet<Permission> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value as Permission);
}

/**
 * Permission implications (IAM-DESIGN §2) — declared here, expanded by the
 * resolver (a later slice). Each key implies the listed parents: holding the
 * key means you transitively hold its parents. The resolver computes the
 * transitive closure ONCE per request so you can never hold an
 * implied-parent-less permission.
 *
 * Declared rules from §2:
 *   - `reveal_pii ⇒ owners.read`
 *   - `export.run ⇒ <resource>.read` (every readable resource — bulk export
 *     reads across the org)
 *   - `*.create / *.update / *.archive ⇒ *.read` (any write implies read)
 *
 * (`view_owner_pii ⇒ view_owners` from §2 is the membership-capability D.54
 *  invariant on the legacy model — its catalog equivalent is the
 *  `owners.reveal_pii ⇒ owners.read` rule below; we do not duplicate the
 *  legacy capability names here.)
 *
 * NOTE: this is a DATA declaration only in Slice 1 — nothing expands it yet.
 * It is pinned by the test so the future resolver inherits a verified map.
 */

/** Every resource that has a `<resource>.read` permission (export.run implies all of them). */
const READABLE_RESOURCES = [
  'projects',
  'buildings',
  'apartments',
  'owners',
  'ownerships',
  'documents',
  'signature_requests',
  'tasks',
  'notes',
  'contractors',
  'imports',
  'mapping_templates',
  'stats',
  'audit',
  'members',
  'roles',
] as const;

/**
 * Build the write⇒read implications mechanically so the map can never drift
 * from the catalog: for every `<r>.create|update|archive` that exists, add
 * `<r>.read` as its parent.
 */
function buildWriteImpliesRead(): Array<[Permission, Permission]> {
  const out: Array<[Permission, Permission]> = [];
  for (const perm of PERMISSIONS) {
    const m = /^(.+)\.(create|update|archive)$/.exec(perm);
    if (!m) continue;
    const read = `${m[1]}.read` as Permission;
    if (PERMISSION_SET.has(read)) out.push([perm, read]);
  }
  return out;
}

/**
 * IMPLICATIONS: child permission → the parent permissions it implies. The
 * resolver unions these transitively. Frozen + pinned by the test.
 */
export const PERMISSION_IMPLICATIONS: ReadonlyMap<Permission, readonly Permission[]> = (() => {
  const map = new Map<Permission, Permission[]>();
  const add = (child: Permission, parent: Permission): void => {
    const arr = map.get(child) ?? [];
    if (!arr.includes(parent)) arr.push(parent);
    map.set(child, arr);
  };

  // reveal_pii ⇒ owners.read
  add('owners.reveal_pii', 'owners.read');

  // export.run ⇒ <resource>.read (for every readable resource)
  for (const r of READABLE_RESOURCES) add('export.run', `${r}.read` as Permission);

  // *.create / *.update / *.archive ⇒ *.read
  for (const [child, parent] of buildWriteImpliesRead()) add(child, parent);

  return map;
})();
