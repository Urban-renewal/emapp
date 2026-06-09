'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useOrgSettings, useUpdateOrgSettings } from '@/hooks/use-org-settings';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * H2 — the per-org CONSENT-THRESHOLD config section (the `consent` namespace).
 *
 * Three per-project-type owner-consent targets (%, 0..100): `tama38_1`
 * (חיזוק), `tama38_2` (הריסה ובנייה), `pinui_binui` (פינוי-בינוי). These are
 * the org-level DEFAULTS the project create-form seeds from; a project STILL
 * overrides per-project (the project-level override is unchanged). Read via
 * GET /api/v1/org/settings and written via PATCH (only the `consent` namespace).
 *
 * AUTHZ (defense-in-depth UX): read gated on `org.settings.read`, write controls
 * on `org.settings.update`. The BE (OrgSettingsPatchSchema + permission guard)
 * is the authoritative gate; the client min/max mirror the schema for UX only.
 *
 * FE DoD: real post-method form with an inline preventDefault submit that calls
 * the mutation — never a GET-fallback submit.
 */
const PCT_MIN = 0;
const PCT_MAX = 100;

export function ConsentConfig() {
  const t = useTranslations('settings.consent');
  const canRead = useHasPermission('org.settings.read');
  const canWrite = useHasPermission('org.settings.update');

  const { data, isLoading, isError } = useOrgSettings({ enabled: canRead });
  const mutation = useUpdateOrgSettings();

  // Local drafts seeded from the resolved server value.
  const [tama38_1, setTama38_1] = useState('66');
  const [tama38_2, setTama38_2] = useState('80');
  const [pinuiBinui, setPinuiBinui] = useState('80');
  useEffect(() => {
    if (data) {
      setTama38_1(String(data.consent.tama38_1));
      setTama38_2(String(data.consent.tama38_2));
      setPinuiBinui(String(data.consent.pinui_binui));
    }
  }, [data]);

  if (!canRead) {
    return (
      <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-consent-h">
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

  const tama38_1Num = Number(tama38_1);
  const tama38_2Num = Number(tama38_2);
  const pinuiBinuiNum = Number(pinuiBinui);
  const inRange = (raw: string, n: number) =>
    raw.trim() !== '' && Number.isFinite(n) && n >= PCT_MIN && n <= PCT_MAX;
  const inBounds =
    inRange(tama38_1, tama38_1Num) &&
    inRange(tama38_2, tama38_2Num) &&
    inRange(pinuiBinui, pinuiBinuiNum);
  const dirty =
    data !== undefined &&
    (tama38_1Num !== data.consent.tama38_1 ||
      tama38_2Num !== data.consent.tama38_2 ||
      pinuiBinuiNum !== data.consent.pinui_binui);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWrite || !inBounds || !dirty) return;
    mutation.mutate({
      consent: { tama38_1: tama38_1Num, tama38_2: tama38_2Num, pinui_binui: pinuiBinuiNum },
    });
  };

  return (
    <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-consent-h">
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
            <PercentField
              name="tama38_1"
              label={t('tama38_1')}
              hint={t('pctHint', { min: PCT_MIN, max: PCT_MAX })}
              value={tama38_1}
              onChange={setTama38_1}
            />
            <PercentField
              name="tama38_2"
              label={t('tama38_2')}
              hint={t('pctHint', { min: PCT_MIN, max: PCT_MAX })}
              value={tama38_2}
              onChange={setTama38_2}
            />
            <PercentField
              name="pinui_binui"
              label={t('pinui_binui')}
              hint={t('pctHint', { min: PCT_MIN, max: PCT_MAX })}
              value={pinuiBinui}
              onChange={setPinuiBinui}
            />
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
              {mutation.isSuccess && !dirty && (
                <span className="text-[11px]" style={{ color: 'var(--success-700)' }}>
                  {t('saved')}
                </span>
              )}
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

interface PercentFieldProps {
  name: string;
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
}

function PercentField({ name, label, hint, value, onChange }: PercentFieldProps) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
        {label}
      </span>
      <input
        type="number"
        name={name}
        inputMode="numeric"
        min={PCT_MIN}
        max={PCT_MAX}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border px-2 py-1 text-sm"
        style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
        dir="ltr"
      />
      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {hint}
      </span>
    </label>
  );
}

function SectionHeading({ section }: { section: string }) {
  return (
    <h2
      id="set-consent-h"
      className="text-[11px] font-semibold uppercase tracking-wider"
      style={{ color: 'var(--text-muted)' }}
    >
      {section}
    </h2>
  );
}
