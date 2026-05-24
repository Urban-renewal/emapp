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
import { AUTHZ_ACTION, AUTHZ_RESOURCE } from './authz.decorators';
import { can, type Action, type Resource, type Role } from './policy';

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
  buildings: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  apartments: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  owners: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
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
  tasks: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager', 'agent'],
    delete: ['manager'],
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
  documents: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  project_assignments: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  signature_requests: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
  },
  imports: {
    read: ['manager', 'agent', 'viewer'],
    create: ['manager'],
    update: ['manager'],
    delete: ['manager'],
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

// ── AuthorizationGuard fail-closed semantics (pure unit) ────────────────
function fakeCtx(opts: {
  resource?: Resource;
  actionOverride?: Action;
  method?: string;
  role?: Role | undefined;
}): ExecutionContext {
  const handler = (): void => undefined;
  const klass = class Ctrl {};
  if (opts.resource) Reflect.defineMetadata(AUTHZ_RESOURCE, opts.resource, klass);
  if (opts.actionOverride) Reflect.defineMetadata(AUTHZ_ACTION, opts.actionOverride, handler);
  return {
    getClass: () => klass,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method ?? 'GET',
        user: opts.role ? { role: opts.role } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('AuthorizationGuard — fail-closed enforcement', () => {
  const g = new AuthorizationGuard();

  it('allows a permitted (role,resource,verb)', () => {
    expect(g.canActivate(fakeCtx({ resource: 'projects', method: 'POST', role: 'manager' }))).toBe(
      true,
    );
  });

  it('DENIES a forbidden role (viewer create projects) → 403', () => {
    expect(() =>
      g.canActivate(fakeCtx({ resource: 'projects', method: 'POST', role: 'viewer' })),
    ).toThrow(/Forbidden|forbidden/);
  });

  it('DENIES agent create projects (manager-only write)', () => {
    expect(() =>
      g.canActivate(fakeCtx({ resource: 'projects', method: 'POST', role: 'agent' })),
    ).toThrow();
  });

  it('fails CLOSED when @AuthzResource is missing (misconfig ≠ open door)', () => {
    expect(() => g.canActivate(fakeCtx({ method: 'GET', role: 'manager' }))).toThrow();
  });

  it('fails CLOSED when there is no authenticated role', () => {
    expect(() =>
      g.canActivate(fakeCtx({ resource: 'projects', method: 'GET', role: undefined })),
    ).toThrow();
  });

  it('honours an action override (POST /owners/search is a READ)', () => {
    expect(
      g.canActivate(
        fakeCtx({ resource: 'owners', method: 'POST', actionOverride: 'read', role: 'viewer' }),
      ),
    ).toBe(true); // viewer may READ owners
    expect(() =>
      g.canActivate(fakeCtx({ resource: 'owners', method: 'POST', role: 'viewer' })),
    ).toThrow(); // but viewer may NOT create
  });

  it('maps verbs: GET→read, POST→create, PUT/PATCH→update, DELETE→delete', () => {
    expect(g.canActivate(fakeCtx({ resource: 'projects', method: 'GET', role: 'viewer' }))).toBe(
      true,
    );
    for (const m of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      expect(() =>
        g.canActivate(fakeCtx({ resource: 'projects', method: m, role: 'viewer' })),
      ).toThrow();
    }
  });
});
