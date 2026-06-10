'use client';

import type { RoleSummary } from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { useDeleteRole } from '@/hooks/use-roles';
import { ApiClientError } from '@/lib/api/errors';

/**
 * A single role card — system or custom. System roles show a locked badge and
 * no edit/delete (the BE rejects mutating them; we don't render the controls).
 * Delete is offered only for custom roles with zero assignments; the BE still
 * re-checks (returns `role_in_use` otherwise).
 */
export function RoleCard({
  role,
  onEdit,
  onAssign,
}: {
  role: RoleSummary;
  onEdit?: () => void;
  onAssign?: () => void;
}) {
  const t = useTranslations('roles');
  const del = useDeleteRole();
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async (): Promise<void> => {
    setError(null);
    try {
      await del.mutateAsync(role.id);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'role_in_use') {
        setError(t('errors.roleInUse'));
      } else {
        setError(t('errors.generic'));
      }
    }
  };

  const canDelete = !role.isSystem && role.assignmentCount === 0;

  return (
    <div className="card card-pad flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>
            <NameDisplay name={role.name} />
          </div>
          {role.description && (
            <div className="mt-0.5 line-clamp-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              <NameDisplay name={role.description} />
            </div>
          )}
        </div>
        {role.isSystem ? (
          <span className="badge badge-info shrink-0">{t('systemBadge')}</span>
        ) : (
          <span className="badge shrink-0">{t('customBadge')}</span>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-1.5 text-[11px]"
        style={{ color: 'var(--text-muted)' }}
      >
        <span>{t('permissionCount', { count: role.permissions.length })}</span>
        <span aria-hidden="true">·</span>
        <span>{t('assignmentCount', { count: role.assignmentCount })}</span>
      </div>

      {error && (
        <p className="text-[12px]" style={{ color: 'var(--danger-700)' }}>
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {onAssign && (
          <Button variant="outline" size="sm" onClick={onAssign}>
            {t('assign')}
          </Button>
        )}
        {onEdit && !role.isSystem && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            {t('edit')}
          </Button>
        )}
        {canDelete && (
          <Button variant="ghost" size="sm" onClick={handleDelete} disabled={del.isPending}>
            {del.isPending ? t('deleting') : t('delete')}
          </Button>
        )}
      </div>
    </div>
  );
}
