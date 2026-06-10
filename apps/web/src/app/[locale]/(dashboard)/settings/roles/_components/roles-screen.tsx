'use client';

import type { RoleSummary } from '@emapp/shared-types';
import { Plus, Shield, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { usePermissions } from '@/hooks/use-permissions';
import { usePermissionCatalog, useRoles } from '@/hooks/use-roles';

import { AssignPanel } from './assign-panel';
import { RoleCard } from './role-card';
import { RoleEditor } from './role-editor';

/**
 * Roles management screen (P2 Phase 1) — list system + custom roles, create /
 * edit a custom role (permission picker grouped by resource), assign roles to
 * members. The whole screen is gated by `roles.manage` at the page level
 * (`roles/page.tsx`); the assign sub-panel additionally gates on `roles.assign`.
 *
 * Defense-in-depth: the BE is the authoritative gate (every endpoint guarded).
 * The FE hides controls only to avoid rendering dead buttons that 403.
 */
export function RolesScreen() {
  const t = useTranslations('roles');
  const { data: roles, isLoading, isError, refetch } = useRoles();
  const { data: catalog } = usePermissionCatalog();
  const { permissions: actorPermissions } = usePermissions();

  // An Owner is detected by the Owner-exclusive markers (same logic as the BE).
  const isOwner = useMemo(
    () => actorPermissions.has('org.transfer_ownership') && actorPermissions.has('org.delete'),
    [actorPermissions],
  );
  const canAssign = actorPermissions.has('roles.assign');

  // Editor state: null = closed; { role: undefined } = create; { role } = edit.
  const [editor, setEditor] = useState<{ role?: RoleSummary } | null>(null);
  const [assignFor, setAssignFor] = useState<RoleSummary | null>(null);

  if (isLoading) return <ListSkeleton rows={5} />;
  if (isError || !roles) {
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {t('loadFailed')}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  const systemRoles = roles.filter((r) => r.isSystem);
  const customRoles = roles.filter((r) => !r.isSystem);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="me-auto text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('listTitle')}
        </h1>
        <Button onClick={() => setEditor({ role: undefined })}>
          <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
          <span>{t('createCustom')}</span>
        </Button>
      </div>

      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('subtitle')}
      </p>

      {editor && catalog && (
        <RoleEditor
          role={editor.role}
          catalog={catalog}
          actorPermissions={actorPermissions}
          governanceLocked={!isOwner}
          onClose={() => setEditor(null)}
        />
      )}

      {assignFor && canAssign && (
        <AssignPanel role={assignFor} onClose={() => setAssignFor(null)} />
      )}

      <section className="flex flex-col gap-2.5">
        <h2
          className="flex items-center gap-1.5 text-sm font-semibold"
          style={{ color: 'var(--text-soft)' }}
        >
          <Shield className="h-4 w-4" aria-hidden="true" />
          {t('customSection')}
        </h2>
        {customRoles.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('noCustom')}
          </p>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
          >
            {customRoles.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                onEdit={() => setEditor({ role })}
                onAssign={canAssign ? () => setAssignFor(role) : undefined}
              />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <h2
          className="flex items-center gap-1.5 text-sm font-semibold"
          style={{ color: 'var(--text-soft)' }}
        >
          <Users className="h-4 w-4" aria-hidden="true" />
          {t('systemSection')}
        </h2>
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
        >
          {systemRoles.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              onAssign={canAssign ? () => setAssignFor(role) : undefined}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
