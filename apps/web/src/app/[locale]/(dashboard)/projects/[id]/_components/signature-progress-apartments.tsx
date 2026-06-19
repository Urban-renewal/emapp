'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { StatusBadge } from '@/components/ui/status-badge';
import { useSignatureProgressApartments } from '@/hooks/use-projects';
import type { ApartmentSignatureProgressViewModel } from '@/models/apartment-signature-progress.vm';

/**
 * Phase-6 "תמונת מצב" — per-apartment DRILL-DOWN (S5d, read-only). An expandable
 * section under the S5a board: collapsed by default, fetches lazily on first open
 * (the hook is gated on `open`), then lists each apartment as
 * "דירה {number} · קומה {floor} · {signedOwners}/{totalOwners} חתמו" + a status
 * chip (success=consented / warning=partial / neutral=none).
 *
 * Pure READ over `GET /api/v1/projects/:id/signature-progress/apartments`; the
 * wire carries only the apartment designation + counts + status — NO PII reaches
 * this component.
 */

export function SignatureProgressApartments({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.boardApartments');
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useSignatureProgressApartments(projectId, open);

  const statusLabel = (row: ApartmentSignatureProgressViewModel): string => {
    switch (row.status) {
      case 'consented':
        return t('statusConsented');
      case 'partial':
        return t('statusPartial');
      default:
        return t('statusNone');
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="self-start text-sm font-medium"
        style={{
          color: 'var(--navy-900)',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
        }}
      >
        {open ? t('toggleHide') : t('toggleShow')}
      </button>

      {open && (
        <div className="flex flex-col gap-1.5">
          {isLoading && (
            <div
              className="h-16 w-full animate-pulse rounded-md"
              style={{ background: 'var(--bg-subtle)' }}
              aria-hidden="true"
            />
          )}

          {isError && (
            <p className="text-sm" style={{ color: 'var(--danger-700)' }}>
              {t('loadFailed')}
            </p>
          )}

          {!isLoading && !isError && data && data.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('empty')}
            </p>
          )}

          {!isLoading && !isError && data && data.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {data.map((row) => (
                <li
                  key={row.apartmentId}
                  className="flex items-center justify-between gap-2 rounded-md px-3 py-2"
                  style={{ background: 'var(--bg-subtle)' }}
                >
                  <span className="text-sm" style={{ color: 'var(--text)' }}>
                    {t('row', {
                      designation: row.designation,
                      signed: row.signedOwners,
                      total: row.totalOwners,
                    })}
                  </span>
                  <StatusBadge intent={row.intent}>{statusLabel(row)}</StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
