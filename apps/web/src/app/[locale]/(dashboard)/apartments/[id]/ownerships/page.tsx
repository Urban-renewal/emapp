'use client';

import { CreateOwnerInput, SetOwnershipsInput } from '@emapp/shared-types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useCreateOwner, useOwnerList } from '@/hooks/use-owners';
import { useApartmentOwners, useSetOwnerships } from '@/hooks/use-ownerships';
import { ApiClientError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

interface Row {
  ownerId: string;
  ownershipPct: number;
  // S3c — ownerships are owner-only (occupants moved to discovery_records).
  relationship: 'owner';
}

const SUM_EPSILON = 0.001;

export default function ApartmentOwnershipsPage() {
  const t = useTranslations('ownerships');
  const tp = useTranslations('projects');
  const to = useTranslations('owners');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const apartmentId = params?.id;

  const current = useApartmentOwners(apartmentId);
  const ownerCatalog = useOwnerList({ limit: 100 });
  const mutation = useSetOwnerships(apartmentId ?? '');
  const [serverError, setServerError] = useState<string | null>(null);

  // §SOLID-L10 closure — seed-from-server pattern, refactored from a
  // brittle `if (rows.length === 0) setRows(...)` heuristic (which
  // would re-seed if the user cleared all rows, masking real "reset"
  // intent). Pattern now:
  //  - `seedRows` is derived from the server payload (useMemo).
  //  - Local `rowsOverride` starts as `null` (use server seed).
  //  - User edits go into `rowsOverride` (no longer null).
  //  - "Reset to server" sets `rowsOverride` back to null.
  //  - `rows` is `rowsOverride ?? seedRows`.
  const seedRows: Row[] = useMemo(
    () =>
      current.data?.items.map((o) => ({
        ownerId: o.ownerId,
        ownershipPct: o.ownershipPct,
        relationship: o.relationship,
      })) ?? [],
    [current.data],
  );
  const [rowsOverride, setRowsOverride] = useState<Row[] | null>(null);
  const rows = rowsOverride ?? seedRows;
  const setRows = useCallback(
    (next: Row[] | ((prev: Row[]) => Row[])): void => {
      setRowsOverride((prev) => (typeof next === 'function' ? next(prev ?? seedRows) : next));
    },
    [seedRows],
  );

  // Owners count toward the 100% invariant. This mirrors `SetOwnershipsInput`'s
  // refine; the UI hint reflects the same rule (single source of truth is the
  // shared schema, re-checked at `onSave`). (S3c — ownerships are owner-only.)
  const ownerSum = useMemo(
    () =>
      rows.filter((r) => r.relationship === 'owner').reduce((a, r) => a + (r.ownershipPct || 0), 0),
    [rows],
  );
  const hasOwners = useMemo(() => rows.some((r) => r.relationship === 'owner'), [rows]);
  // Legal end states for the OWNER sum: 0 (no owners / cleared) or 100.
  const sumValid = !hasOwners || Math.abs(ownerSum - 100) <= SUM_EPSILON;
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
    setRows((rs) => [...rs, { ownerId: candidate.id, ownershipPct: 0, relationship: 'owner' }]);
  }

  function removeRow(idx: number) {
    setRows((rs) => rs.filter((_, i) => i !== idx));
  }

  function updateRow(idx: number, next: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...next } : r)));
  }

  // Inline create — when a freshly created owner lands, append it as a
  // new owner row so it's immediately part of the atomic set-replace.
  function onOwnerCreated(ownerId: string) {
    setRows((rs) => [...rs, { ownerId, ownershipPct: 0, relationship: 'owner' }]);
  }

  async function onSave() {
    if (!apartmentId) return;
    setServerError(null);
    const body = {
      owners: rows.map((r) => ({
        ownerId: r.ownerId,
        ownershipPct: r.ownershipPct,
        relationship: r.relationship,
      })),
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
                    // §SEC-M4 — dir="auto" for partial bidi isolation in <option>.
                    <option key={o.id} value={o.id} dir="auto">
                      {o.name}
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

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          {t('addRow')}
        </Button>
        <InlineCreateOwner
          labels={{
            open: t('addPerson'),
            name: to('field.name'),
            nationalId: to('field.nationalId'),
            phone: to('field.phone'),
            create: to('create'),
            creating: to('creating'),
            cancel: tp('cancel'),
            idExists: to('field.idExists'),
            createFailed: to('createFailed'),
            required: tp('field.required'),
          }}
          onCreated={onOwnerCreated}
        />
        <div
          className={cn(
            'ms-auto text-sm font-medium',
            sumValid ? 'text-foreground' : 'text-destructive',
          )}
        >
          {t('sumLabel', { sum: ownerSum.toFixed(2) })}
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

interface InlineCreateOwnerLabels {
  open: string;
  name: string;
  nationalId: string;
  phone: string;
  create: string;
  creating: string;
  cancel: string;
  idExists: string;
  createFailed: string;
  required: string;
}

/**
 * Inline "+ אדם חדש" — a mini owner-create form that REUSES the same
 * `/owners` POST (via `useCreateOwner` → `createOwner` → idempotent POST)
 * as the standalone owner-create page, so no separate page trip is
 * needed. On success the new owner becomes selectable as a new ownership
 * row in the SAME flow; the atomic set-replace PUT is unchanged.
 */
function InlineCreateOwner({
  labels,
  onCreated,
}: {
  labels: InlineCreateOwnerLabels;
  onCreated: (ownerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [phone, setPhone] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const mutation = useCreateOwner();
  const { serverError, handle, reset } = useApiErrorHandler({
    codeOverrides: {
      owner_exists: () => labels.idExists,
    },
    fallback: () => labels.createFailed,
  });

  function close() {
    setOpen(false);
    setName('');
    setNationalId('');
    setPhone('');
    setFieldError(null);
    reset();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    reset();
    setFieldError(null);
    // Reuse the shared write-contract for validation — single source of
    // truth, no re-encoded field rules. `phone` is omitted when blank.
    const candidate = {
      name,
      national_id: nationalId,
      ...(phone.trim() ? { phone } : {}),
    };
    const parsed = CreateOwnerInput.safeParse(candidate);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? labels.required);
      return;
    }
    try {
      const owner = await mutation.mutateAsync(parsed.data);
      onCreated(owner.id);
      close();
    } catch (err) {
      handle(err);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {labels.open}
      </Button>
    );
  }

  return (
    // method="post" — defense in depth; this form carries national_id
    // (D.19 PII). A GET fallback would leak it to the URL/logs.
    <form
      method="post"
      action=""
      onSubmit={onSubmit}
      className="w-full space-y-3 rounded-md border bg-card p-3"
    >
      <div className="space-y-1">
        <label htmlFor="inline-owner-name" className="text-sm font-medium">
          {labels.name}
        </label>
        <input
          id="inline-owner-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="inline-owner-id" className="text-sm font-medium">
          {labels.nationalId}
        </label>
        <input
          id="inline-owner-id"
          type="text"
          inputMode="numeric"
          maxLength={9}
          autoComplete="off"
          dir="ltr"
          value={nationalId}
          onChange={(e) => setNationalId(e.target.value)}
          className="w-full rounded-md border px-3 py-2 font-mono text-sm"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="inline-owner-phone" className="text-sm font-medium">
          {labels.phone}
        </label>
        <input
          id="inline-owner-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="w-full rounded-md border px-3 py-2 font-mono text-sm"
        />
      </div>
      {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
      {serverError && <p className="text-xs text-destructive">{serverError}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          {labels.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? labels.creating : labels.create}
        </Button>
      </div>
    </form>
  );
}
