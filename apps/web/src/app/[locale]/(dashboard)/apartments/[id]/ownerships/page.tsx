'use client';

import { SetOwnershipsInput } from '@emapp/shared-types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useOwnerList } from '@/hooks/use-owners';
import { useApartmentOwners, useSetOwnerships } from '@/hooks/use-ownerships';
import { ApiClientError } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

interface Row {
  ownerId: string;
  ownershipPct: number;
}

const SUM_EPSILON = 0.001;

export default function ApartmentOwnershipsPage() {
  const t = useTranslations('ownerships');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const apartmentId = params?.id;

  const current = useApartmentOwners(apartmentId);
  const ownerCatalog = useOwnerList({ limit: 100 });
  const mutation = useSetOwnerships(apartmentId ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);

  // Seed rows from current state once it loads (seed-once; further
  // edits are user-driven).
  useEffect(() => {
    if (current.data && rows.length === 0) {
      setRows(current.data.items.map((o) => ({ ownerId: o.id, ownershipPct: o.ownershipPct })));
    }
  }, [current.data, rows.length]);

  const sum = useMemo(() => rows.reduce((a, r) => a + (r.ownershipPct || 0), 0), [rows]);
  const sumValid = rows.length === 0 || Math.abs(sum - 100) <= SUM_EPSILON;
  const dupeIds = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.ownerId)) dupes.add(r.ownerId);
      else seen.add(r.ownerId);
    }
    return dupes;
  }, [rows]);

  const availableOwners = ownerCatalog.data?.items ?? [];
  const isReady = current.isSuccess && ownerCatalog.isSuccess;

  function addRow() {
    const candidate = availableOwners.find((o) => !rows.some((r) => r.ownerId === o.id));
    if (!candidate) return;
    setRows((rs) => [...rs, { ownerId: candidate.id, ownershipPct: 0 }]);
  }

  function removeRow(idx: number) {
    setRows((rs) => rs.filter((_, i) => i !== idx));
  }

  function updateRow(idx: number, next: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...next } : r)));
  }

  async function onSave() {
    if (!apartmentId) return;
    setServerError(null);
    const body = {
      owners: rows.map((r) => ({ ownerId: r.ownerId, ownershipPct: r.ownershipPct })),
    };
    const parsed = SetOwnershipsInput.safeParse(body);
    if (!parsed.success) {
      setServerError(t('clientInvalid'));
      return;
    }
    try {
      await mutation.mutateAsync(parsed.data);
      router.push(`/apartments/${apartmentId}`);
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.code === 'ownership_sum_invalid') setServerError(t('serverSumInvalid'));
        else if (e.code === 'forbidden') setServerError(tp('archiveFailed'));
        else setServerError(t('saveFailed'));
      } else {
        setServerError(t('saveFailed'));
      }
    }
  }

  if (!isReady) {
    return <p className="text-sm text-muted-foreground">{tp('loading')}</p>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <p className="text-sm">
        <Link href={`/apartments/${apartmentId}`} className="underline">
          {tp('backToList')}
        </Link>
      </p>
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>

      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('emptyRows')}</p>
        ) : (
          rows.map((r, idx) => {
            const owner = availableOwners.find((o) => o.id === r.ownerId);
            const isDupe = dupeIds.has(r.ownerId);
            return (
              <div
                key={`${r.ownerId}-${idx}`}
                className={cn(
                  'flex items-center gap-3 rounded-md border bg-card p-3',
                  isDupe && 'border-destructive',
                )}
              >
                <select
                  value={r.ownerId}
                  onChange={(e) => updateRow(idx, { ownerId: e.target.value })}
                  className="min-w-[12rem] rounded-md border bg-background px-3 py-2 text-sm"
                  aria-label={t('ownerLabel')}
                >
                  {availableOwners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name /* <option> can't host bdi; option text is innerText only */}
                    </option>
                  ))}
                  {owner === undefined && <option value={r.ownerId}>{r.ownerId}</option>}
                </select>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={r.ownershipPct}
                  onChange={(e) => updateRow(idx, { ownershipPct: Number(e.target.value || 0) })}
                  className="w-24 rounded-md border px-3 py-2 text-end text-sm"
                  aria-label={t('shareLabel')}
                />
                <span className="text-xs text-muted-foreground">%</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ms-auto"
                  onClick={() => removeRow(idx)}
                >
                  {t('removeRow')}
                </Button>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          {t('addRow')}
        </Button>
        <div
          className={cn('text-sm font-medium', sumValid ? 'text-foreground' : 'text-destructive')}
        >
          {t('sumLabel', { sum: sum.toFixed(2) })}
        </div>
      </div>

      {!sumValid && rows.length > 0 && (
        <p className="text-xs text-destructive">{t('sumMustBe100')}</p>
      )}
      {dupeIds.size > 0 && <p className="text-xs text-destructive">{t('duplicate')}</p>}
      {serverError && <p className="text-sm text-destructive">{serverError}</p>}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          {tp('cancel')}
        </Button>
        <Button
          type="button"
          onClick={onSave}
          disabled={mutation.isPending || (!sumValid && rows.length > 0) || dupeIds.size > 0}
        >
          {mutation.isPending ? tp('archiving') : t('save')}
        </Button>
      </div>
    </div>
  );
}
