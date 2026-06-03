import 'reflect-metadata';

import type { Permission } from './permissions';
import type { Action, Resource } from './policy';

// ───────────────────────────────────────────────────────────────────────────
// Metadata keys read by AuthorizationGuard.
//
// Using reflect-metadata directly (not Nest SetMetadata/Reflector) so the guard
// can be a zero-DI `new AuthorizationGuard()` in @UseGuards — no per-module
// wiring, one enforcement point.
//
// SLICE 5a — the enterprise-IAM cutover. The guard now resolves its decision
// through the `PermissionService` engine (the live authorizer), NOT the legacy
// `policy.ts` matrix. The per-HANDLER `@RequirePermission('<permission>')`
// decorator is the new declaration; the legacy per-CLASS `@AuthzResource` +
// per-handler verb/`@AuthzAction` model is removed from the request path.
// `policy.ts` STAYS in the tree (now dead) — it is the equivalence oracle and
// is deleted in slice 6.
// ───────────────────────────────────────────────────────────────────────────

/** Slice-5a: the engine permission a handler requires (read by AuthorizationGuard). */
export const AUTHZ_PERMISSION = 'authz:permission';
/** Slice-5a: sentinel — a handler authorized by tenant-membership only. */
export const AUTHZ_TENANT_ONLY = 'authz:tenant_only';

// Legacy slice-≤4 keys. RETAINED as exports because the architecture
// fail-open scanner (`agent-capability-guard.ts`) and the slice-3 equivalence
// machinery still reference the legacy decorators/keys by name for source-text
// matching; the runtime guard no longer reads these.
export const AUTHZ_RESOURCE = 'authz:resource';
export const AUTHZ_ACTION = 'authz:action';

/**
 * SLICE 5a — the SINGLE per-handler authorization declaration. The handler is
 * allowed iff `PermissionService.can(user, <permission>, <org-scope>)` is true
 * (resolved once per request through the engine, RLS-scoped to the request's
 * org). Replaces the legacy class-level `@AuthzResource` + verb→action default.
 *
 * EVERY domain route handler MUST carry EITHER this or `@TenantScoped()`;
 * AuthorizationGuard fails CLOSED (403) on a handler that declares neither, so a
 * new slice cannot ship an un-policed endpoint by omission.
 *
 * Record-level scoping (agent → assigned project; note author; self-scoped
 * notifications) is UNCHANGED — it stays in the service, expressed as the
 * assignment scope. This decorator is the COARSE org-scope permission gate the
 * legacy role-matrix guard used to be.
 */
export function RequirePermission(permission: Permission): MethodDecorator {
  return (_t, _k, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(AUTHZ_PERMISSION, permission, descriptor.value as object);
  };
}

/**
 * SLICE 5a — the explicit "no engine permission gates this; tenant membership
 * is the authorization" marker. Used ONLY for the handful of surfaces the new
 * permission catalog deliberately has NO permission for (the slice-3
 * `NO_ENGINE_EQUIVALENT` set):
 *
 *   - `GET /…/shares` (list) + `PATCH /shares/:id` (perms edit): a share is a
 *     contractor delivery channel, not a separately-listed read resource; its
 *     read folds under project/contractor read and its write is create+revoke
 *     only (no `shares.read` / `shares.update` permission exists).
 *   - `notifications.*`: self-scoped by RLS (own rows only, `user_id =
 *     app.user_id`) — NOT a role-permission surface. Any authenticated org
 *     member manages only their own notifications.
 *
 * This is NOT an open door: AuthGuard + TenantGuard still run before this, so
 * the actor is an authenticated member of the request's org, and RLS + the
 * service's own record/self scoping govern WHICH rows they touch. Each use is
 * pinned by the authz cutover spec (a NEW `@TenantScoped` handler must map to a
 * documented `NO_ENGINE_EQUIVALENT` cell, never a forgotten gate).
 */
export function TenantScoped(): MethodDecorator {
  return (_t, _k, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(AUTHZ_TENANT_ONLY, true, descriptor.value as object);
  };
}

// ───────────────────────────────────────────────────────────────────────────
// LEGACY decorators (slice ≤4) — RETAINED, NO LONGER READ AT REQUEST TIME.
//
// The runtime guard (slice 5a) reads `@RequirePermission` / `@TenantScoped`
// instead. These remain so the architecture scanner + equivalence proof keep
// their source-text references compiling; they are removed in slice 6 with
// `policy.ts`. Marking them deprecated steers new code to the engine model.
// ───────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Slice 5a — superseded by `@RequirePermission`. No longer read by
 * AuthorizationGuard. Removed with `policy.ts` in slice 6.
 */
export function AuthzResource(resource: Resource): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(AUTHZ_RESOURCE, resource, target);
  };
}

/**
 * @deprecated Slice 5a — superseded by `@RequirePermission`. No longer read by
 * AuthorizationGuard. Removed with `policy.ts` in slice 6.
 */
export function AuthzAction(action: Action): MethodDecorator {
  return (_t, _k, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(AUTHZ_ACTION, action, descriptor.value as object);
  };
}
