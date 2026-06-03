'use client';

import { useMemo } from 'react';

import { useSessionProfile } from './use-session';

/**
 * IAM slice 5b — the single FE permission gate.
 *
 * The enterprise-IAM engine (slices 1-4) resolves the actor's EXACT effective
 * permission-set on the active org scope and ships it on `GET /me` as
 * `permissions: string[]` (catalog strings, e.g. `projects.create`,
 * `owners.reveal_pii`). This hook is the ONE place the FE reads that set —
 * every control / nav item / page that used to gate on a ROLE STRING
 * (`role === 'manager'` …) now gates on a PERMISSION via `useHasPermission`.
 *
 * SOLID: one source of truth (the `/me` permission set), no scattered role
 * checks. Add a new gated control → pick its catalog permission, wrap it; no
 * role math anywhere in the component.
 *
 * DEFENSE IN DEPTH — this is UX only. The BE remains the authoritative gate
 * (every privileged endpoint is guarded by the AuthorizationGuard regardless
 * of what the FE renders). Hiding a control the actor can't use is purely so
 * we never render a dead button that 403s on click (the DV-ORG-9 finding).
 *
 * Loading / missing semantics (safe default = deny):
 *  - while `/me` is in flight, `permissions` is `undefined` → every
 *    `useHasPermission` returns `false` (no flash of write controls before the
 *    set resolves; the controls appear once the grant is confirmed).
 *  - an older `/me` producer that omits the field is treated as "no grants".
 */

/**
 * The actor's effective permission-set (a `Set` for O(1) membership checks).
 * Empty while `/me` is loading or if the field is absent — the safe default.
 */
export function usePermissions(): {
  permissions: Set<string>;
  /** True once the `/me` profile (and thus the permission set) has resolved. */
  isResolved: boolean;
} {
  const { data, isSuccess } = useSessionProfile();
  const permissions = useMemo(() => new Set(data?.permissions ?? []), [data?.permissions]);
  return { permissions, isResolved: isSuccess };
}

/**
 * Does the current actor hold `permission`? Returns `false` until `/me`
 * resolves (deny-by-default — never flash a write control pre-resolution).
 *
 * @example
 *   const canCreate = useHasPermission('projects.create');
 *   {canCreate && <Link href="/projects/new">…</Link>}
 */
export function useHasPermission(permission: string): boolean {
  const { permissions } = usePermissions();
  return permissions.has(permission);
}
