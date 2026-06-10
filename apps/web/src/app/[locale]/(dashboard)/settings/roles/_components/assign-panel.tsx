'use client';

import type { RoleSummary } from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useMemberList } from '@/hooks/use-members';
import { useAssignRole, useRevokeRole } from '@/hooks/use-roles';
import { ApiClientError } from '@/lib/api/errors';

/**
 * Assign / revoke a role to/from a member. Lists ACTIVE members (you can only
 * grant a role to an accepted member) and offers assign + revoke for the chosen
 * member. The BE enforces the anti-escalation boundary (the actor can only grant
 * a role whose permission set ⊆ their own; only an Owner grants Owner/Admin) and
 * the last-Owner safety on revoke — surfaced here as localized errors.
 */
export function AssignPanel({ role, onClose }: { role: RoleSummary; onClose: () => void }) {
  const t = useTranslations('roles');
  const { data } = useMemberList({ limit: 100 });
  const assign = useAssignRole();
  const revoke = useRevokeRole();
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const members = useMemo(() => (data?.items ?? []).filter((m) => m.isActive), [data?.items]);

  const run = async (mode: 'assign' | 'revoke'): Promise<void> => {
    setError(null);
    setOk(null);
    if (!userId) {
      setError(t('errors.pickMember'));
      return;
    }
    try {
      if (mode === 'assign') {
        await assign.mutateAsync({ userId, roleId: role.id });
        setOk(t('assignedOk'));
      } else {
        await revoke.mutateAsync({ userId, roleId: role.id });
        setOk(t('revokedOk'));
      }
    } catch (err) {
      setError(translateAssignError(err, t));
    }
  };

  const pending = assign.isPending || revoke.isPending;

  return (
    <div className="card card-pad flex flex-col gap-3">
      <h2 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
        {t('assignTitle', { role: role.name })}
      </h2>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="assign-member"
          className="text-xs font-medium"
          style={{ color: 'var(--text-soft)' }}
        >
          {t('field.member')}
        </label>
        <select
          id="assign-member"
          className="input"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        >
          <option value="">{t('field.pickMember')}</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name} · {m.email}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
          {error}
        </p>
      )}
      {ok && (
        <p className="text-sm" style={{ color: 'var(--success-700)' }}>
          {ok}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => run('assign')} disabled={pending}>
          {assign.isPending ? t('assigning') : t('assign')}
        </Button>
        <Button variant="outline" onClick={() => run('revoke')} disabled={pending}>
          {revoke.isPending ? t('revoking') : t('revoke')}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}

function translateAssignError(err: unknown, t: ReturnType<typeof useTranslations>): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case 'role_grant_exceeds_actor':
        return t('errors.grantExceedsActor');
      case 'owner_required_for_tier':
        return t('errors.ownerRequiredForTier');
      case 'cannot_revoke_last_owner':
        return t('errors.lastOwner');
      case 'cannot_assign_self':
        return t('errors.assignSelf');
      case 'member_not_found':
        return t('errors.memberNotFound');
      case 'assignment_not_found':
        return t('errors.assignmentNotFound');
      default:
        return t('errors.generic');
    }
  }
  return t('errors.generic');
}
