'use client';

import type { PermissionCatalogEntry, RoleSummary } from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useCreateRole, useUpdateRole } from '@/hooks/use-roles';
import { ApiClientError } from '@/lib/api/errors';

import { PermissionPicker } from './permission-picker';

/**
 * Create / edit a custom role. `role` undefined ⇒ create; otherwise edit (a
 * system role is never passed here — the list hides edit for `isSystem`).
 *
 * The submit is a real form `method="post"` (DoD: no GET-fallback credential
 * leak) with an inline onSubmit that prevents the native navigation and calls
 * the mutation. The BE re-validates the subset + governance boundary; on a 422
 * we surface the offending permissions.
 */
export function RoleEditor({
  role,
  catalog,
  actorPermissions,
  governanceLocked,
  onClose,
}: {
  role?: RoleSummary;
  catalog: PermissionCatalogEntry[];
  actorPermissions: Set<string>;
  governanceLocked: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('roles');
  const create = useCreateRole();
  const update = useUpdateRole();
  const isEdit = role !== undefined;

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [error, setError] = useState<string | null>(null);

  const toggle = (permission: string, next: boolean): void => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(permission);
      else copy.delete(permission);
      return copy;
    });
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    const permissions = [...selected];
    if (name.trim().length < 2) {
      setError(t('errors.nameTooShort'));
      return;
    }
    if (permissions.length === 0) {
      setError(t('errors.noPermissions'));
      return;
    }
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: role.id,
          body: { name: name.trim(), description: description.trim() || null, permissions },
        });
      } else {
        await create.mutateAsync({
          name: name.trim(),
          description: description.trim() || undefined,
          permissions,
        });
      }
      onClose();
    } catch (err) {
      setError(translateError(err, t));
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <form method="post" onSubmit={submit} className="card card-pad flex flex-col gap-4">
      <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
        {isEdit ? t('editTitle') : t('createTitle')}
      </h2>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="role-name"
          className="text-xs font-medium"
          style={{ color: 'var(--text-soft)' }}
        >
          {t('field.name')}
        </label>
        <input
          id="role-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
          minLength={2}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="role-description"
          className="text-xs font-medium"
          style={{ color: 'var(--text-soft)' }}
        >
          {t('field.description')}
        </label>
        <input
          id="role-description"
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={280}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium" style={{ color: 'var(--text-soft)' }}>
          {t('field.permissions')}
        </span>
        <PermissionPicker
          catalog={catalog}
          selected={selected}
          onToggle={toggle}
          actorPermissions={actorPermissions}
          governanceLocked={governanceLocked}
        />
      </div>

      {error && (
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t('saving') : isEdit ? t('save') : t('create')}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Map a BE error code to a localized message; fall back to a generic. */
function translateError(err: unknown, t: ReturnType<typeof useTranslations>): string {
  if (err instanceof ApiClientError) {
    const code = err.code;
    const details = err.details as { permissions?: string[] } | undefined;
    const perms = details?.permissions?.join(', ');
    switch (code) {
      case 'governance_owner_only':
        return t('errors.governanceOwnerOnly', { permissions: perms ?? '' });
      case 'permission_not_held':
        return t('errors.permissionNotHeld', { permissions: perms ?? '' });
      case 'unknown_permission':
        return t('errors.unknownPermission', { permissions: perms ?? '' });
      case 'role_name_taken':
        return t('errors.nameTaken');
      case 'system_role_immutable':
        return t('errors.systemImmutable');
      default:
        return t('errors.generic');
    }
  }
  return t('errors.generic');
}
