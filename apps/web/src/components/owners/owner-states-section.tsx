'use client';

import type { OwnerStateKind, OwnerStateView } from '@emapp/shared-types';
import { ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { StatusBadge, type Intent } from '@/components/ui/status-badge';
import {
  useCreateOwnerState,
  useOwnerStates,
  useResolveOwnerState,
} from '@/hooks/use-owner-states';

/** The closed kind list (FE mirror of the BE enum — totality is compile-checked
 *  by the Record types below). Order = the form's select order. */
const KIND_ORDER: readonly OwnerStateKind[] = [
  'competency',
  'dispute',
  'transfer',
  'lien',
  'verify',
  'consent_withdrawal',
];

/** Per-kind badge intent. Blocking kinds (competency/dispute) read DANGER; the
 *  rest WARNING — at-a-glance "this one stops the signature". */
const KIND_INTENT: Record<OwnerStateKind, Intent> = {
  competency: 'danger',
  dispute: 'danger',
  transfer: 'warning',
  lien: 'warning',
  verify: 'warning',
  consent_withdrawal: 'warning',
};

/**
 * Slice 2.5 — the owner legal/life-state section on the owner dossier.
 *
 * Renders the ACTIVE states as legible badges (blocking ones flagged), shows the
 * MASKED guardian identity only (never cleartext), and lets a manager add/resolve
 * a state in one click. Plain Hebrew throughout; the kind labels are i18n keys
 * under `owners.states.*`. Empty/error/loading states are all legible.
 *
 * `canManage` gates the add/resolve controls (the BE re-asserts manager-tier; the
 * controls simply don't render for non-managers so a viewer/agent sees a clean
 * read-only badge list).
 */
export function OwnerStatesSection({
  ownerId,
  canManage,
}: {
  ownerId: string;
  canManage: boolean;
}) {
  const t = useTranslations('owners.states');
  const tData = useTranslations('dataState');
  const { data: states, isLoading, isError } = useOwnerStates(ownerId);
  const create = useCreateOwnerState(ownerId);
  const resolve = useResolveOwnerState(ownerId);
  const { confirm, dialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onResolve(state: OwnerStateView) {
    setActionError(null);
    if (!(await confirm({ message: t('resolve') + '?' }))) return;
    try {
      await resolve.mutateAsync(state.id);
    } catch {
      setActionError(t('resolveFailed'));
    }
  }

  return (
    <section className="card card-pad" aria-labelledby="own-states-h">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="own-states-h"
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          {t('section')}
        </h2>
        {canManage && !showForm && (
          <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
            {t('add')}
          </Button>
        )}
      </div>

      <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        {t('sectionHint')}
      </p>

      {isLoading && (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          {tData('loading')}
        </p>
      )}
      {isError && (
        <p className="mt-3 text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
          {t('loadFailed')}
        </p>
      )}

      {!isLoading && !isError && states && states.length === 0 && !showForm && (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          {t('none')}
        </p>
      )}

      {!isLoading && !isError && states && states.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {states.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2"
              style={{ background: 'var(--surface-soft, transparent)' }}
            >
              <StatusBadge intent={KIND_INTENT[s.kind]}>{t(`kind.${s.kind}`)}</StatusBadge>
              {s.isBlocking && (
                <span
                  className="inline-flex items-center gap-1 text-xs font-medium"
                  style={{ color: 'var(--danger-700)' }}
                >
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('blockingBadge')}
                </span>
              )}
              {s.subKind && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  · {s.subKind}
                </span>
              )}
              {s.guardianNameMasked && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  · {t('guardianLabel')}: <span dir="ltr">{s.guardianNameMasked}</span>
                </span>
              )}
              {s.hasGuardianContact && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  · {t('guardianContactOnFile')}
                </span>
              )}
              {canManage && (
                <div className="ms-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onResolve(s)}
                    disabled={resolve.isPending}
                  >
                    {resolve.isPending ? t('resolving') : t('resolve')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && showForm && (
        <OwnerStateForm
          pending={create.isPending}
          onCancel={() => {
            setShowForm(false);
            setActionError(null);
          }}
          onSubmit={async (body) => {
            setActionError(null);
            try {
              await create.mutateAsync(body);
              setShowForm(false);
            } catch {
              setActionError(t('addFailed'));
            }
          }}
        />
      )}

      {actionError && (
        <p className="mt-2 text-sm" style={{ color: 'var(--danger-700)' }} role="alert">
          {actionError}
        </p>
      )}
      {dialog}
    </section>
  );
}

/** The add-state form. Guardian fields show only for `competency` (the only kind
 *  that carries a guardian). All guardian inputs are optional + encrypted server-
 *  side; the form never displays a stored guardian value. */
function OwnerStateForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    kind: OwnerStateKind;
    subKind?: string;
    guardianName?: string;
    guardianPhone?: string;
    guardianNationalId?: string;
  }) => void;
}) {
  const t = useTranslations('owners.states');
  const [kind, setKind] = useState<OwnerStateKind>('competency');
  const [subKind, setSubKind] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [guardianNationalId, setGuardianNationalId] = useState('');

  const showGuardian = kind === 'competency';

  return (
    // Inline onSubmit + preventDefault — no GET-fallback (DOD-BROWSER-SMOKE).
    <form
      method="post"
      className="mt-3 flex flex-col gap-3 rounded-md border p-3"
      style={{ borderColor: 'var(--border)' }}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          kind,
          subKind: subKind.trim() || undefined,
          guardianName: showGuardian && guardianName.trim() ? guardianName.trim() : undefined,
          guardianPhone: showGuardian && guardianPhone.trim() ? guardianPhone.trim() : undefined,
          guardianNationalId:
            showGuardian && guardianNationalId.trim() ? guardianNationalId.trim() : undefined,
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span style={{ color: 'var(--text-muted)' }}>{t('form.kindLabel')}</span>
        <select
          className="rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          value={kind}
          onChange={(e) => setKind(e.target.value as OwnerStateKind)}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {t(`kind.${k}`)}
            </option>
          ))}
        </select>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t(`kindHint.${kind}`)}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span style={{ color: 'var(--text-muted)' }}>{t('form.subKindLabel')}</span>
        <input
          type="text"
          maxLength={80}
          className="rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          placeholder={t('form.subKindPlaceholder')}
          value={subKind}
          onChange={(e) => setSubKind(e.target.value)}
        />
      </label>

      {showGuardian && (
        <fieldset
          className="flex flex-col gap-2 rounded-md border p-2"
          style={{ borderColor: 'var(--border)' }}
        >
          <legend className="px-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('guardianLabel')}
          </legend>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {t('form.guardianHint')}
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span style={{ color: 'var(--text-muted)' }}>{t('form.guardianNameLabel')}</span>
            <input
              type="text"
              maxLength={120}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              value={guardianName}
              onChange={(e) => setGuardianName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span style={{ color: 'var(--text-muted)' }}>{t('form.guardianPhoneLabel')}</span>
            <input
              type="tel"
              dir="ltr"
              maxLength={40}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              value={guardianPhone}
              onChange={(e) => setGuardianPhone(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span style={{ color: 'var(--text-muted)' }}>{t('form.guardianNationalIdLabel')}</span>
            <input
              type="text"
              dir="ltr"
              maxLength={40}
              className="rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              value={guardianNationalId}
              onChange={(e) => setGuardianNationalId(e.target.value)}
            />
          </label>
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t('adding') : t('form.submit')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
          {t('form.cancel')}
        </Button>
      </div>
    </form>
  );
}
