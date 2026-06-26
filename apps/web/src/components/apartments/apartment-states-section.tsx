'use client';

import type { ApartmentStateKind, ApartmentStateView } from '@emapp/shared-types';
import { ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { StatusBadge, type Intent } from '@/components/ui/status-badge';
import {
  useApartmentStates,
  useCreateApartmentState,
  useResolveApartmentState,
} from '@/hooks/use-apartment-states';

/** The closed kind list (FE mirror of the BE enum — totality is compile-checked by
 *  the Record types below). Order = the form's select order. */
const KIND_ORDER: readonly ApartmentStateKind[] = [
  'deceased',
  'dispute',
  'poa',
  'eviction',
  'repairs',
  'rights_transfer',
];

/** Per-kind badge intent. Blocking kinds (deceased/dispute/eviction) read DANGER; the
 *  rest WARNING — at-a-glance "this one stops the signature". */
const KIND_INTENT: Record<ApartmentStateKind, Intent> = {
  deceased: 'danger',
  dispute: 'danger',
  eviction: 'danger',
  poa: 'warning',
  repairs: 'warning',
  rights_transfer: 'warning',
};

/**
 * Slice 2.7 — the apartment legal/life-state section on the apartment dossier.
 *
 * Renders the ACTIVE states as legible badges (blocking ones flagged) and lets a
 * manager add/resolve a state in one click. Plain Hebrew throughout; the kind labels
 * are i18n keys under `apartments.states.*`. Empty/error/loading states are legible.
 * PII-FREE — no person/contact fields are collected or shown.
 *
 * `canManage` gates the add/resolve controls (the BE re-asserts manager-tier; the
 * controls simply don't render for non-managers so a viewer/agent sees a clean
 * read-only badge list).
 */
export function ApartmentStatesSection({
  apartmentId,
  canManage,
}: {
  apartmentId: string;
  canManage: boolean;
}) {
  const t = useTranslations('apartments.states');
  const tData = useTranslations('dataState');
  const { data: states, isLoading, isError } = useApartmentStates(apartmentId);
  const create = useCreateApartmentState(apartmentId);
  const resolve = useResolveApartmentState(apartmentId);
  const { confirm, dialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onResolve(state: ApartmentStateView) {
    setActionError(null);
    if (!(await confirm({ message: t('resolve') + '?' }))) return;
    try {
      await resolve.mutateAsync(state.id);
    } catch {
      setActionError(t('resolveFailed'));
    }
  }

  return (
    <section className="card card-pad" aria-labelledby="apt-states-h">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="apt-states-h"
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
              {s.note && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  · {s.note}
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
        <ApartmentStateForm
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

/** The add-state form. PII-FREE — only the kind + bounded non-PII labels (subKind /
 *  note). No person/contact inputs of any kind. */
function ApartmentStateForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: { kind: ApartmentStateKind; subKind?: string; note?: string }) => void;
}) {
  const t = useTranslations('apartments.states');
  const [kind, setKind] = useState<ApartmentStateKind>('deceased');
  const [subKind, setSubKind] = useState('');
  const [note, setNote] = useState('');

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
          note: note.trim() || undefined,
        });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span style={{ color: 'var(--text-muted)' }}>{t('form.kindLabel')}</span>
        <select
          className="rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          value={kind}
          onChange={(e) => setKind(e.target.value as ApartmentStateKind)}
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

      <label className="flex flex-col gap-1 text-sm">
        <span style={{ color: 'var(--text-muted)' }}>{t('form.noteLabel')}</span>
        <textarea
          maxLength={280}
          rows={2}
          className="rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          placeholder={t('form.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('form.noteHint')}
        </span>
      </label>

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
