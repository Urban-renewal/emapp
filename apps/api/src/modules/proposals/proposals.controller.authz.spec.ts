/**
 * Approval-Inbox controller — route-gate + role-grant pins (the #505 tightening).
 *
 * Authored separately from the impl. Two layers, NO DB required (the gate is
 * declared via `@RequirePermission` metadata + resolved from the static system-
 * role permission sets):
 *
 *  1. ROUTE GATES — each handler carries the DEDICATED `proposals.*` permission
 *     (was borrowing `signature_requests.*`). A drift back to the borrowed
 *     permission, or a missing gate, fails here.
 *  2. ROLE GRANTS — the manager-and-above system roles hold the full `proposals.*`
 *     family; agent / viewer / external_read hold NONE of it. This is the
 *     anti-escalation pin: the new permissions do NOT widen WHO can approve, and
 *     no role holds a `proposals.*` permission it could never use (the inbox is
 *     manager-only via `requireManager`). With the route gates now ALSO requiring
 *     these permissions, a non-manager lacking `proposals.*` is blocked at the
 *     AuthorizationGuard, not only at the service `requireManager`.
 */
import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { AUTHZ_PERMISSION } from '../../common/authz/authz.decorators';
import { PERMISSION_SET } from '../../common/authz/permissions';
import { SYSTEM_ROLE_BY_KEY, type SystemRoleKey } from '../../common/authz/system-roles';

import { ProposalsController } from './proposals.controller';

const PROPOSALS_FAMILY = ['proposals.read', 'proposals.approve', 'proposals.reject'] as const;

function gateOf(handler: unknown): string | undefined {
  return Reflect.getMetadata(AUTHZ_PERMISSION, handler as object) as string | undefined;
}

const proto = ProposalsController.prototype;

describe('ProposalsController — route gates use the dedicated proposals.* family', () => {
  it('GET /proposals (list) requires proposals.read (NOT signature_requests.read)', () => {
    expect(gateOf(proto.list)).toBe('proposals.read');
  });

  it('POST :id/approve requires proposals.approve (NOT signature_requests.send)', () => {
    expect(gateOf(proto.approve)).toBe('proposals.approve');
  });

  it('POST :id/reject requires proposals.reject (NOT signature_requests.read)', () => {
    expect(gateOf(proto.reject)).toBe('proposals.reject');
  });

  it('every gate is a real catalog permission (no typo / dead gate)', () => {
    for (const handler of [proto.list, proto.approve, proto.reject]) {
      const perm = gateOf(handler);
      expect(perm, 'handler must declare a @RequirePermission').toBeDefined();
      expect(PERMISSION_SET.has(perm as never), `${perm} must be a real catalog permission`).toBe(
        true,
      );
    }
  });

  it('no proposals route still borrows a signature_requests permission', () => {
    for (const handler of [proto.list, proto.approve, proto.reject]) {
      expect(gateOf(handler)?.startsWith('signature_requests.')).toBe(false);
    }
  });
});

describe('proposals.* role grants — manager-and-above ONLY (no privilege widening)', () => {
  const has = (key: SystemRoleKey, perm: string): boolean =>
    new Set<string>(SYSTEM_ROLE_BY_KEY.get(key)!.permissions).has(perm);

  it('owner / admin / manager hold the FULL proposals.* family', () => {
    for (const key of ['owner', 'admin', 'manager'] as const) {
      for (const perm of PROPOSALS_FAMILY) {
        expect(has(key, perm), `${key} should hold ${perm}`).toBe(true);
      }
    }
  });

  it('agent / viewer / external_read hold NONE of proposals.* (manager-only surface)', () => {
    for (const key of ['agent', 'viewer', 'external_read'] as const) {
      for (const perm of PROPOSALS_FAMILY) {
        expect(has(key, perm), `${key} must NOT hold ${perm}`).toBe(false);
      }
    }
  });

  it('the family is exactly read/approve/reject in the catalog', () => {
    const family = [...PERMISSION_SET].filter((p) => p.startsWith('proposals.')).sort();
    expect(family).toEqual([...PROPOSALS_FAMILY].sort());
  });
});
