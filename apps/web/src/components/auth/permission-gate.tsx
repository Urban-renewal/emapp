'use client';

import type { ReactNode } from 'react';

import { useHasPermission } from '@/hooks/use-permissions';

/**
 * IAM slice 5b — declarative permission gate for a subtree.
 *
 * Renders `children` only if the current actor holds `permission` (resolved
 * from `GET /me`'s effective permission-set via `useHasPermission`). UX only;
 * the BE is the authoritative gate (defense in depth) — this just keeps us
 * from rendering a control that would 403 on click.
 *
 * Use the hook directly when the gated thing is one element inside other JSX;
 * use this wrapper when it reads cleaner (e.g. a whole nav item / card).
 *
 * @example
 *   <PermissionGate permission="projects.create">
 *     <Link href="/projects/new" className="btn btn-primary">…</Link>
 *   </PermissionGate>
 */
export function PermissionGate({
  permission,
  children,
  fallback = null,
}: {
  permission: string;
  children: ReactNode;
  /** Rendered when the actor lacks `permission` (default: nothing). */
  fallback?: ReactNode;
}): ReactNode {
  const allowed = useHasPermission(permission);
  return allowed ? children : fallback;
}
