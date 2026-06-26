/**
 * F1 (defense-in-depth) — external-shares controller authz DECLARATION pins.
 *
 * Why this spec: the live allow/deny matrix for external_share writes is
 * enforced by the service's `requireManager()` gate (manager allowed;
 * agent + viewer 403) — proven in `external-shares.spec.ts`. This file pins the
 * COARSE controller-level authz DECLARATION so a future new route cannot ship
 * ungated by omission (AuthorizationGuard fails CLOSED on a handler that
 * declares neither `@RequirePermission` nor `@TenantScoped`).
 *
 * The permission catalog models shares as create + revoke ONLY
 * (`shares.create` / `shares.revoke`) — there is no `shares.read` /
 * `shares.update` / extend / resend permission. So:
 *   - create  → @RequirePermission('shares.create')
 *   - revoke  → @RequirePermission('shares.revoke')
 *   - list / update / extend / resend → @TenantScoped() (NO_ENGINE_EQUIVALENT)
 *
 * MATRIX-UNCHANGED proof: `shares.create` / `shares.revoke` are held by the
 * Agent role too (system-roles), so the coarse gate alone would let an agent
 * past — but `requireManager()` in the service still 403s any non-manager, so
 * the EFFECTIVE result (manager allowed; agent + viewer 403) is identical to
 * before this decorator was added. This is documented as
 * AGENT_MANAGER_ONLY_PERMISSIONS (shares.create / shares.revoke) and mirrors the
 * sibling contractor `shares` controller exactly.
 */
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { AGENT_MANAGER_ONLY_PERMISSIONS } from '../../common/authz/agent-effective-permissions';
import { AUTHZ_PERMISSION, AUTHZ_TENANT_ONLY } from '../../common/authz/authz.decorators';
import { isPermission } from '../../common/authz/permissions';
import { SYSTEM_ROLE_BY_KEY } from '../../common/authz/system-roles';

import { ExternalSharesController } from './external-shares.controller';

type Handler = (...args: unknown[]) => unknown;

function handlerOf(name: string): Handler {
  const h = (ExternalSharesController.prototype as unknown as Record<string, Handler | undefined>)[
    name
  ];
  if (typeof h !== 'function') throw new Error(`no handler named ${name} on controller`);
  return h;
}
function permissionOf(name: string): unknown {
  return Reflect.getMetadata(AUTHZ_PERMISSION, handlerOf(name));
}
function isTenantScoped(name: string): boolean {
  return Reflect.getMetadata(AUTHZ_TENANT_ONLY, handlerOf(name)) === true;
}

describe('ExternalSharesController — authz declaration (F1 defense-in-depth)', () => {
  it('create carries @RequirePermission("shares.create")', () => {
    expect(permissionOf('create')).toBe('shares.create');
    expect(isTenantScoped('create')).toBe(false);
  });

  it('revoke carries @RequirePermission("shares.revoke")', () => {
    expect(permissionOf('revoke')).toBe('shares.revoke');
    expect(isTenantScoped('revoke')).toBe(false);
  });

  it('the catalog-keyless routes (list/update/extend/resend/resolveDocumentAccess) stay @TenantScoped', () => {
    // resolveDocumentAccess (SEC-H1) is a read-only org-member resolution
    // surface — no in-catalog read permission exists for external shares, so it
    // carries @TenantScoped like list/update (NO_ENGINE_EQUIVALENT). RLS +
    // the resolver's fail-closed decision are the substantive gates.
    for (const name of [
      'list',
      'update',
      'extend',
      'resend',
      'resolveDocumentAccess',
      // W-4.1 — party_request handlers (manager-only WRITES enforced in the
      // service via requireManager; no in-catalog party-request permission).
      'listPartyRequests',
      'createPartyRequest',
      'cancelPartyRequest',
    ]) {
      expect(isTenantScoped(name), `${name} tenant-scoped`).toBe(true);
      expect(permissionOf(name), `${name} has no @RequirePermission`).toBeUndefined();
    }
  });

  it('EVERY route declares exactly one authz gate (no ungated handler)', () => {
    for (const name of [
      'list',
      'create',
      'update',
      'extend',
      'resend',
      'revoke',
      'resolveDocumentAccess',
      'listPartyRequests',
      'createPartyRequest',
      'cancelPartyRequest',
    ]) {
      const hasPerm = permissionOf(name) !== undefined;
      const tenant = isTenantScoped(name);
      expect(hasPerm || tenant, `${name} declares an authz gate`).toBe(true);
      expect(hasPerm && tenant, `${name} declares exactly one`).toBe(false);
    }
  });

  it('the declared write keys are real catalog permissions', () => {
    expect(isPermission('shares.create')).toBe(true);
    expect(isPermission('shares.revoke')).toBe(true);
  });

  it('MATRIX UNCHANGED: manager holds the keys; viewer does NOT; agent is service-gated', () => {
    const manager = new Set(SYSTEM_ROLE_BY_KEY.get('manager')!.permissions);
    const viewer = new Set(SYSTEM_ROLE_BY_KEY.get('viewer')!.permissions);

    // Manager allowed at the coarse gate (and at the service requireManager).
    expect(manager.has('shares.create')).toBe(true);
    expect(manager.has('shares.revoke')).toBe(true);

    // Viewer denied at BOTH the coarse gate and the service gate → 403 unchanged.
    expect(viewer.has('shares.create')).toBe(false);
    expect(viewer.has('shares.revoke')).toBe(false);

    // Agent would pass the COARSE gate (holds the role permission) but the
    // service's requireManager still 403s it — pinned here so the coarse
    // divergence is known-and-intentional, not an effective widening.
    expect(AGENT_MANAGER_ONLY_PERMISSIONS.has('shares.create')).toBe(true);
    expect(AGENT_MANAGER_ONLY_PERMISSIONS.has('shares.revoke')).toBe(true);
  });
});
