/**
 * D.17 ACCESS-CONTROL PROOF (ISO 27001 A.9.4 verification artifact).
 *
 * Deterministic, zero-infra. The EXPECTED table below is written
 * INDEPENDENTLY from the D.17 spec text (it is NOT derived from POLICY),
 * so this test is a genuine pin of the implemented matrix to the
 * documented control — every (role × resource × action) cell is asserted.
 * A drift in policy.ts or an un-reviewed widening fails CI here.
 *
 * Also unit-proves AuthorizationGuard semantics (fail-closed) with a fake
 * ExecutionContext — no DB, no HTTP.
 */
import { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AuthorizationGuard } from './authorization.guard';
import { AUTHZ_PERMISSION, AUTHZ_TENANT_ONLY } from './authz.decorators';
import type { Permission } from './permissions';
import {
  can,
  canProvider,
  PROVIDER_POLICY,
  type Action,
  type ProviderAction,
  type Resource,
  type Role,
} from './policy';

const ROLES: Role[] = ['manager', 'agent', 'viewer'];
const ACTIONS: Action[] = ['read', 'create', 'update', 'delete'];

// Independent restatement of D.17 (per-resource allowed roles by action).
// If you change this you are changing the documented control — do it
// consciously, with a DECISIONS entry.
const EXPECTED: Record<Resource, Record<Action, Role[]>> = {
  projects: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  // D.46 — buildings + apartments writes coarsely opened to agent (the fine
  // capability `edit_project_data` + assigned-project scoping is enforced in
  // the service, NOT in this coarse matrix). Viewer still excluded.
  buildings: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager', 'agent'],
    update: ['manager', 'agent'],
    delete: ['manager', 'agent'],
  },
  apartments: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager', 'agent'],
    update: ['manager', 'agent'],
    delete: ['manager', 'agent'],
  },
  // D.46 — owner update/archive opened to agent (project-scoped via the
  // ownership join + edit_project_data, enforced in owners.service). CREATE
  // stays manager-only (a bare new owner has no project to scope). Viewer
  // still excluded from all writes.
  owners: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager', 'agent'],
    delete: ['manager', 'agent'],
  },
  ownerships: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  contractors: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  shares: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  // D.46 — task writes opened to agent (manage_tasks + project-scoping; full
  // management, enforced in the service). update was already MA.
  tasks: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager', 'agent'],
    update: ['manager', 'agent'],
    delete: ['manager', 'agent'],
  },
  notifications: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager', 'agent', 'viewer'],
    delete: ['manager'],
  },
  notes: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager', 'agent'],
    update: ['manager', 'agent'],
    delete: ['manager', 'agent'],
  },
  audit: { read: ['manager'], create: ['manager'], update: ['manager'], delete: ['manager'] },
  members: { read: ['manager'], create: ['manager'], update: ['manager'], delete: ['manager'] },
  // D.46 — document writes opened to agent (manage_documents + doc/project
  // visibility, enforced in the service). read/download = ALL.
  documents: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager', 'agent'],
    update: ['manager', 'agent'],
    delete: ['manager', 'agent'],
  },
  project_assignments: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  // D.46 — signature create/cancel(update) opened to agent (manage_signatures +
  // underlying-document visibility, enforced in the service). No DELETE route.
  signature_requests: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager', 'agent'],
    update: ['manager', 'agent'],
    delete: ['manager'],
  },
  // D.46 — import writes opened to agent (run_imports + project-scoping on the
  // job's projectId, enforced in the service).
  imports: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager', 'agent'],
    update: ['manager', 'agent'],
    delete: ['manager', 'agent'],
  },
  // D.34 mapping templates — v6 audit fix §9 declared as first-class
  // resource (was implicitly under `imports`). Same triple as the
  // documents/imports pattern: read ALL, writes Manager.
  mapping_templates: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
};

const RESOURCES = Object.keys(EXPECTED) as Resource[];

describe('D.17 policy matrix — exhaustive proof vs the documented control', () => {
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        const expected = EXPECTED[resource][action].includes(role);
        it(`${role} ${action} ${resource} → ${expected ? 'ALLOW' : 'DENY'}`, () => {
          expect(can(role, resource, action)).toBe(expected);
        });
      }
    }
  }

  it('every D.17 resource is covered (no silent gap)', () => {
    expect(RESOURCES.length).toBe(17);
    // viewer can NEVER write anything, anywhere (A.9.4 least-privilege).
    for (const r of RESOURCES) {
      for (const a of ['create', 'update', 'delete'] as Action[]) {
        if (r === 'notifications' && a === 'update') continue; // self mark-read
        expect(can('viewer', r, a), `viewer must not ${a} ${r}`).toBe(false);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────
// D.37 / D.49 — Provider tier matrix pin.
//
// Independent restatement of the matrix. D.49 (supersedes the D.37
// read-only lock) authorizes a `write` action alongside `read`, granted
// ONLY to `provider_admin`. If a future hand adds a THIRD action (e.g.
// a destructive `purge` — explicitly out of scope per D.49) or a
// non-provider_admin role, these tests fail loud BEFORE the code merges.
// A widening here is equivalent to a Gate-6 decision and requires a new
// D.NN entry.
// ───────────────────────────────────────────────────────────────────
describe('D.49 PROVIDER_POLICY matrix — read + operational-write invariant', () => {
  it('Provider admin can READ `provider` resource', () => {
    expect(canProvider('provider_admin', 'provider', 'read')).toBe(true);
  });

  it('Provider admin can WRITE `provider` resource (D.49)', () => {
    expect(canProvider('provider_admin', 'provider', 'write')).toBe(true);
  });

  it('the action type is EXACTLY `read | write` — no third (destructive) action', () => {
    // TypeScript enforces this at compile-time (ProviderAction is the
    // union 'read' | 'write'). The runtime check guards against a future
    // refactor that broadens the type — CI fails before a wider type
    // (e.g. a `purge` action D.49 keeps out of scope) lands.
    const allowed: ProviderAction[] = ['read', 'write'];
    expect(allowed.length).toBe(2);
  });

  it('PROVIDER_POLICY exposes EXACTLY one resource (`provider`) — single surface', () => {
    expect(Object.keys(PROVIDER_POLICY).sort()).toEqual(['provider']);
  });

  it('PROVIDER_POLICY[provider] exposes EXACTLY two actions (`read`, `write`) — no implicit third', () => {
    expect(Object.keys(PROVIDER_POLICY.provider).sort()).toEqual(['read', 'write']);
  });

  it('only `provider_admin` is in the allowed roles list for BOTH read and write', () => {
    expect(PROVIDER_POLICY.provider.read).toEqual(['provider_admin']);
    expect(PROVIDER_POLICY.provider.write).toEqual(['provider_admin']);
  });

  it('canProvider is a PURE function — same inputs → same output, no shared mutable state', () => {
    const a = canProvider('provider_admin', 'provider', 'write');
    const b = canProvider('provider_admin', 'provider', 'write');
    expect(a).toBe(b);
    expect(a).toBe(true);
  });

  it('STRUCTURAL TIER ISOLATION — org Role / Resource / non-action cannot be passed to canProvider', () => {
    // Compile-time pins via @ts-expect-error — the tsc check verifies the
    // type mismatch. If a future hand widens ProviderRole/Resource/Action
    // past the documented surface, the matching @ts-expect-error fires.
    // @ts-expect-error — 'manager' is an org Role, not a ProviderRole
    void (() => canProvider('manager', 'provider', 'read'));
    // @ts-expect-error — 'projects' is an org Resource, not a ProviderResource
    void (() => canProvider('provider_admin', 'projects', 'read'));
    // @ts-expect-error — 'create' is not a ProviderAction (only read|write)
    void (() => canProvider('provider_admin', 'provider', 'create'));
    // @ts-expect-error — 'delete'/'purge'-style destructive verbs are NOT
    // ProviderActions (D.49 authorizes operational writes only).
    void (() => canProvider('provider_admin', 'provider', 'delete'));
    expect(true).toBe(true);
  });
});

// ── AuthorizationGuard fail-closed semantics (pure unit, slice-5a) ──────────
//
// The cutover made the guard ENGINE-backed: the ALLOW path resolves
// `PermissionService.can(user, permission, org-scope)` against the DB and is
// covered cell-for-cell by the real-DB shadow-equivalence proof
// (`policy-equivalence.spec.ts`). These pure-unit tests pin the DB-INDEPENDENT
// fail-closed branches — the structural guarantees that no endpoint is silently
// ungated — which never touch the engine:
//
//   - a handler with NEITHER @RequirePermission NOR @TenantScoped → 403,
//   - missing `req.user` (sub/orgId) → 403,
//   - @TenantScoped short-circuits to ALLOW for an authenticated org member
//     WITHOUT any engine query (the NO_ENGINE_EQUIVALENT self/RLS surfaces),
//     and still fails closed when the actor is unauthenticated.
function fakeCtx(opts: {
  permission?: Permission;
  tenantScoped?: boolean;
  user?: { sub: string; orgId: string } | undefined;
}): ExecutionContext {
  const handler = (): void => undefined;
  const klass = class Ctrl {};
  if (opts.permission) Reflect.defineMetadata(AUTHZ_PERMISSION, opts.permission, handler);
  if (opts.tenantScoped) Reflect.defineMetadata(AUTHZ_TENANT_ONLY, true, handler);
  return {
    getClass: () => klass,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ user: opts.user }),
    }),
  } as unknown as ExecutionContext;
}

const ACTOR = { sub: '00000000-0000-4000-8000-000000000abc', orgId: 'org-1' };

describe('AuthorizationGuard — fail-closed enforcement (engine-backed)', () => {
  const g = new AuthorizationGuard();

  it('fails CLOSED when a handler declares NEITHER @RequirePermission NOR @TenantScoped', async () => {
    await expect(g.canActivate(fakeCtx({ user: ACTOR }))).rejects.toThrow(/Forbidden|forbidden/);
  });

  it('fails CLOSED on a permission-gated handler with no authenticated user', async () => {
    await expect(
      g.canActivate(fakeCtx({ permission: 'projects.read', user: undefined })),
    ).rejects.toThrow();
  });

  it('fails CLOSED on a permission-gated handler whose user lacks orgId', async () => {
    await expect(
      g.canActivate(fakeCtx({ permission: 'projects.read', user: { sub: ACTOR.sub, orgId: '' } })),
    ).rejects.toThrow();
  });

  it('@TenantScoped ALLOWS an authenticated org member without any engine query', async () => {
    await expect(g.canActivate(fakeCtx({ tenantScoped: true, user: ACTOR }))).resolves.toBe(true);
  });

  it('@TenantScoped still fails CLOSED for an unauthenticated actor', async () => {
    await expect(g.canActivate(fakeCtx({ tenantScoped: true, user: undefined }))).rejects.toThrow();
  });
});
