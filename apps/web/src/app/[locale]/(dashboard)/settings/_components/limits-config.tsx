'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useToast } from '@/components/ui/action-toast';
import { useOrgSettings, useUpdateOrgSettings } from '@/hooks/use-org-settings';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * P6-2 — the per-org LIMITS config section (the `limits` namespace).
 *
 * `bulkCap` = max rows in a bulk action (int 1..1000, default 200);
 * `defaultPageSize` = list page-size default (int 1..100, default 25). These are
 * ergonomics knobs, not security controls. Read via GET /api/v1/org/settings and
 * written via PATCH (only the `limits` namespace).
 *
 * AUTHZ (defense-in-depth UX): read gated on `org.settings.read`, write controls
 * on `org.settings.update`. The BE (OrgSettingsPatchSchema + permission guard)
 * is the authoritative gate; the client min/max mirror the schema for UX only.
 *
 * FE DoD: real post-method form with an inline preventDefault submit that calls
 * the mutation — never a GET-fallback submit.
 */
const BULK_CAP_MIN = 1;
const BULK_CAP_MAX = 1000;
const PAGE_SIZE_MIN = 1;
const PAGE_SIZE_MAX = 100;

const isInt = (n: number) => Number.isInteger(n);

export function LimitsConfig() {
  const t = useTranslations('settings.limits');
  const canRead = useHasPermission('org.settings.read');
  const canWrite = useHasPermission('org.settings.update');

  const { data, isLoading, isError } = useOrgSettings({ enabled: canRead });
  const mutation = useUpdateOrgSettings();
  const toast = useToast();

  // M0+G6 — announce a successful save through the app-root live-region/toast
  // (replaces the bespoke inline "saved" span). Fires once per save success.
  useEffect(() => {
    if (mutation.isSuccess) toast.show({ message: t('saved') });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on the success transition; toast.show is stable
  }, [mutation.isSuccess]);

  // Local drafts seeded from the resolved server value.
  const [bulkCap, setBulkCap] = useState('200');
  const [defaultPageSize, setDefaultPageSize] = useState('25');
  useEffect(() => {
    if (data) {
      setBulkCap(String(data.limits.bulkCap));
      setDefaultPageSize(String(data.limits.defaultPageSize));
    }
  }, [data]);

  if (!canRead) {
    return (
      <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-limits-h">
        <SectionHeading section={t('section')} />
        <p className="text-sm" style={{ color: 'var(--text)' }}>
          {t('description')}
        </p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {t('noPermission')}
        </p>
      </section>
    );
  }

  const bulkCapNum = Number(bulkCap);
  const pageSizeNum = Number(defaultPageSize);
  const bulkCapValid =
    bulkCap.trim() !== '' &&
    isInt(bulkCapNum) &&
    bulkCapNum >= BULK_CAP_MIN &&
    bulkCapNum <= BULK_CAP_MAX;
  const pageSizeValid =
    defaultPageSize.trim() !== '' &&
    isInt(pageSizeNum) &&
    pageSizeNum >= PAGE_SIZE_MIN &&
    pageSizeNum <= PAGE_SIZE_MAX;
  const inBounds = bulkCapValid && pageSizeValid;
  const dirty =
    data !== undefined &&
    (bulkCapNum !== data.limits.bulkCap || pageSizeNum !== data.limits.defaultPageSize);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWrite || !inBounds || !dirty) return;
    mutation.mutate({ limits: { bulkCap: bulkCapNum, defaultPageSize: pageSizeNum } });
  };

  return (
    <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-limits-h">
      <SectionHeading section={t('section')} />
      <p className="text-sm" style={{ color: 'var(--text)' }}>
        {t('description')}
      </p>

      {isLoading && (
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {t('loading')}
        </p>
      )}
      {isError && (
        <p className="text-[11px]" role="alert" style={{ color: 'var(--danger-700)' }}>
          {t('loadError')}
        </p>
      )}

      {data && (
        <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-4" disabled={!canWrite || mutation.isPending}>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
                {t('bulkCap')}
              </span>
              <input
                type="number"
                name="bulkCap"
                inputMode="numeric"
                min={BULK_CAP_MIN}
                max={BULK_CAP_MAX}
                step={1}
                value={bulkCap}
                onChange={(e) => setBulkCap(e.target.value)}
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                dir="ltr"
              />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {t('bulkCapHint', { min: BULK_CAP_MIN, max: BULK_CAP_MAX })}
              </span>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
                {t('defaultPageSize')}
              </span>
              <input
                type="number"
                name="defaultPageSize"
                inputMode="numeric"
                min={PAGE_SIZE_MIN}
                max={PAGE_SIZE_MAX}
                step={1}
                value={defaultPageSize}
                onChange={(e) => setDefaultPageSize(e.target.value)}
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                dir="ltr"
              />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {t('defaultPageSizeHint', { min: PAGE_SIZE_MIN, max: PAGE_SIZE_MAX })}
              </span>
            </label>
          </fieldset>

          {!inBounds && (
            <p className="text-[11px]" role="alert" style={{ color: 'var(--danger-700)' }}>
              {t('outOfBounds')}
            </p>
          )}

          {canWrite ? (
            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={!dirty || !inBounds || mutation.isPending}
              >
                {mutation.isPending ? t('saving') : t('save')}
              </button>
              {mutation.isError && (
                <span className="text-[11px]" role="alert" style={{ color: 'var(--danger-700)' }}>
                  {t('saveError')}
                </span>
              )}
            </div>
          ) : (
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {t('readOnly')}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function SectionHeading({ section }: { section: string }) {
  return (
    <h2
      id="set-limits-h"
      className="text-[11px] font-semibold uppercase tracking-wider"
      style={{ color: 'var(--text-muted)' }}
    >
      {section}
    </h2>
  );
}
