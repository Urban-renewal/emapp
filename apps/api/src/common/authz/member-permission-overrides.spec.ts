/**
 * P2 Phase 2 — the per-user override layer, resolution unit tests.
 *
 * These are PURE engine tests: we subclass `PermissionService` to stub the two
 * protected fetches (`resolveAssignments` + `resolveOverrides`) with in-memory
 * rows, so the layering logic — `final = (role-derived ∪ GRANT) − DENY`, with
 * DENY winning and DENY removing the EXACT permission (no implied-child cascade)
 * — is exercised with NO database. (The real-DB matrix/scope/RLS coverage lives
 * in `permission.service.spec.ts`.)
 *
 * Proven here:
 *   - GRANT adds a permission the role doesn't give.
 *   - DENY removes a permission the role gives.
 *   - DENY beats a same-permission GRANT (stale grant+deny pair → deny-wins).
 *   - DENY removes the EXACT permission only (does NOT cascade to implied
 *     children: denying `owners.read` keeps `owners.update`).
 *   - GRANT pulls in its implication parents (granted child ⇒ parent).
 *   - Scope coverage: an org-scope DENY removes on a project target; a
 *     project-scope override does NOT affect a different project.
 */
import { describe, expect, it } from 'vitest';

import {
  PermissionResolutionCache,
  PermissionService,
  type AuthzUser,
  type Scope,
} from './permission.service';
import { type Permission } from './permissions';

type StubAssignment = { scopeType: 'org' | 'project'; scopeId: string; permission: string };
type StubOverride = StubAssignment & { effect: 'grant' | 'deny' };

/**
 * A `PermissionService` whose two DB fetches are replaced by fixed in-memory
 * rows — the layering logic runs against these with no `tx` touched.
 */
class StubEngine extends PermissionService {
  constructor(
    private readonly assignments: StubAssignment[],
    private readonly overrides: StubOverride[],
  ) {
    super();
  }
  protected override async resolveAssignments(): Promise<StubAssignment[]> {
    return this.assignments;
  }
  protected override async resolveOverrides(): Promise<StubOverride[]> {
    return this.overrides;
  }
}

const USER: AuthzUser = { id: 'u-1', orgId: 'org-1' };
const ORG: Scope = { type: 'org', id: 'org-1' };
const PROJECT_A: Scope = { type: 'project', id: 'proj-a' };
const PROJECT_B: Scope = { type: 'project', id: 'proj-b' };

// The tx + cache are unused by the stub fetches but required by the signature.
const TX = {} as never;
const cache = (): PermissionResolutionCache => new PermissionResolutionCache();

async function resolve(
  assignments: StubAssignment[],
  overrides: StubOverride[],
  scope: Scope = ORG,
): Promise<ReadonlySet<Permission>> {
  const engine = new StubEngine(assignments, overrides);
  return engine.effectivePermissions(USER, scope, TX, cache());
}

describe('member permission overrides — engine resolution', () => {
  it('GRANT adds a permission the role does not give', async () => {
    const eff = await resolve(
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'projects.read' }],
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'export.run', effect: 'grant' }],
    );
    expect(eff.has('export.run')).toBe(true);
    expect(eff.has('projects.read')).toBe(true);
  });

  it('DENY removes a permission the role grants', async () => {
    const eff = await resolve(
      [
        { scopeType: 'org', scopeId: 'org-1', permission: 'projects.read' },
        { scopeType: 'org', scopeId: 'org-1', permission: 'export.run' },
      ],
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'export.run', effect: 'deny' }],
    );
    expect(eff.has('export.run')).toBe(false);
    expect(eff.has('projects.read')).toBe(true);
  });

  it('DENY beats a same-permission GRANT (stale pair → deny-wins)', async () => {
    const eff = await resolve(
      [],
      [
        { scopeType: 'org', scopeId: 'org-1', permission: 'audit.read', effect: 'grant' },
        { scopeType: 'org', scopeId: 'org-1', permission: 'audit.read', effect: 'deny' },
      ],
    );
    expect(eff.has('audit.read')).toBe(false);
  });

  it('DENY removes the EXACT permission only — no implied-child cascade', async () => {
    // owners.update ⇒ owners.read (implication). Denying owners.read must NOT
    // strip owners.update; the member keeps write, just not the explicit read.
    const eff = await resolve(
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'owners.update' }],
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'owners.read', effect: 'deny' }],
    );
    expect(eff.has('owners.read')).toBe(false);
    expect(eff.has('owners.update')).toBe(true);
  });

  it('GRANT pulls in its implication parents (granted child ⇒ parent)', async () => {
    // Granting owners.reveal_pii implies owners.read via the closure.
    const eff = await resolve(
      [],
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'owners.reveal_pii', effect: 'grant' }],
    );
    expect(eff.has('owners.reveal_pii')).toBe(true);
    expect(eff.has('owners.read')).toBe(true);
  });

  it('an org-scope DENY removes on a project target', async () => {
    const eff = await resolve(
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'projects.read' }],
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'projects.read', effect: 'deny' }],
      PROJECT_A,
    );
    expect(eff.has('projects.read')).toBe(false);
  });

  it('a project-scope override does NOT affect a different project', async () => {
    const assignments: StubAssignment[] = [
      { scopeType: 'org', scopeId: 'org-1', permission: 'projects.read' },
    ];
    const overrides: StubOverride[] = [
      { scopeType: 'project', scopeId: 'proj-a', permission: 'projects.read', effect: 'deny' },
    ];
    // On project A the deny applies; on project B it does not.
    const onA = await resolve(assignments, overrides, PROJECT_A);
    const onB = await resolve(assignments, overrides, PROJECT_B);
    expect(onA.has('projects.read')).toBe(false);
    expect(onB.has('projects.read')).toBe(true);
  });

  it('a project-scope GRANT does NOT leak to the org scope', async () => {
    const eff = await resolve(
      [],
      [{ scopeType: 'project', scopeId: 'proj-a', permission: 'export.run', effect: 'grant' }],
      ORG,
    );
    expect(eff.has('export.run')).toBe(false);
  });

  it('no overrides ⇒ identical to the role-derived set', async () => {
    const eff = await resolve(
      [{ scopeType: 'org', scopeId: 'org-1', permission: 'projects.update' }],
      [],
    );
    // projects.update ⇒ projects.read closure, nothing added or removed.
    expect(eff.has('projects.update')).toBe(true);
    expect(eff.has('projects.read')).toBe(true);
    expect(eff.size).toBe(2);
  });
});
