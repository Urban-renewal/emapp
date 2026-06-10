'use client';

import { useTranslations } from 'next-intl';

import { ListSkeleton } from '@/components/ui/list-skeleton';
import { usePermissions } from '@/hooks/use-permissions';

import { RolesScreen } from './_components/roles-screen';

/**
 * Roles management page (P2 Phase 1) — Owner/Admin only (`roles.manage`).
 *
 * The page gates on the `/me` effective permission set: while it resolves we
 * show a skeleton (deny-by-default — never flash the screen pre-resolution);
 * if the actor lacks `roles.manage` we show a not-authorized notice instead of
 * the management UI. The BE is the authoritative gate on every endpoint — this
 * is purely so we never render a screen whose every action would 403.
 *
 * The dashboard layout already enforces session presence + org-tier isolation
 * (provider tier has its own surface), so this page only adds the fine
 * permission gate.
 */
export default function RolesPage() {
  const t = useTranslations('roles');
  const { permissions, isResolved } = usePermissions();

  if (!isResolved) return <ListSkeleton rows={5} />;

  if (!permissions.has('roles.manage')) {
    return (
      <div className="mx-auto max-w-2xl">
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {t('notAuthorized')}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <RolesScreen />
    </div>
  );
}
