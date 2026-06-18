'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useToast } from '@/components/ui/action-toast';
import { useOrgSettings, useUpdateOrgSettings } from '@/hooks/use-org-settings';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * P6-2 — the per-org LOCALIZATION config section (the `locale` + `timezone`
 * namespaces of the OrgSettings seam).
 *
 * `locale` ∈ {he,en,ar} (default 'he'); `timezone` is the org's stored
 * preference (default 'Asia/Jerusalem') chosen from a small set of common
 * IL/UTC zones. Both are read via GET /api/v1/org/settings and written via PATCH
 * (only the touched namespaces).
 *
 * AUTHZ (defense-in-depth UX): read gated on `org.settings.read`, write controls
 * on `org.settings.update`. The BE (OrgSettingsPatchSchema + permission guard)
 * is the authoritative gate; client bounds are UX only.
 *
 * FE DoD: real post-method form with an inline preventDefault submit that calls
 * the mutation — never a GET-fallback submit.
 */
const LOCALES = ['he', 'en', 'ar'] as const;
type Locale = (typeof LOCALES)[number];

const TIMEZONES = ['Asia/Jerusalem', 'UTC', 'Europe/London', 'America/New_York'] as const;

export function LocalizationConfig() {
  const t = useTranslations('settings.localization');
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
  const [locale, setLocale] = useState<Locale>('he');
  const [timezone, setTimezone] = useState('Asia/Jerusalem');
  useEffect(() => {
    if (data) {
      setLocale(data.locale);
      setTimezone(data.timezone);
    }
  }, [data]);

  if (!canRead) {
    return (
      <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-localization-h">
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

  const localeValid = (LOCALES as readonly string[]).includes(locale);
  const timezoneValid = timezone.trim().length >= 1;
  const inBounds = localeValid && timezoneValid;
  const dirty = data !== undefined && (locale !== data.locale || timezone !== data.timezone);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWrite || !inBounds || !dirty || data === undefined) return;
    // PATCH only the changed scalar namespaces.
    const patch: { locale?: Locale; timezone?: string } = {};
    if (locale !== data.locale) patch.locale = locale;
    if (timezone !== data.timezone) patch.timezone = timezone;
    mutation.mutate(patch);
  };

  return (
    <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-localization-h">
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
                {t('locale')}
              </span>
              <select
                name="locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
              >
                {LOCALES.map((loc) => (
                  <option key={loc} value={loc}>
                    {t(`localeOption.${loc}`)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
                {t('timezone')}
              </span>
              <select
                name="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                dir="ltr"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {t('timezoneHint')}
              </span>
            </label>
          </fieldset>

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
      id="set-localization-h"
      className="text-[11px] font-semibold uppercase tracking-wider"
      style={{ color: 'var(--text-muted)' }}
    >
      {section}
    </h2>
  );
}
