'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useOrgSettings, useUpdateOrgSettings } from '@/hooks/use-org-settings';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * P6-2 — the per-org BRANDING (sender identity) config section.
 *
 * `senderName` is the org-facing display name on outbound messages (the value
 * now wired into the email From DISPLAY name — see
 * docs/decision-records/P6-branding-email-from.md). It is EDITABLE here.
 *
 * `emailFrom` (a custom from-ADDRESS) is DISPLAY-ONLY / disabled: a custom
 * sending address is deferred until owner domain-verification exists (spoofing +
 * deliverability), so this UI never PATCHes it — it only shows the stored value
 * with the "needs domain verification" note.
 *
 * AUTHZ (defense-in-depth UX): read gated on `org.settings.read`, write controls
 * on `org.settings.update`. The BE (OrgSettingsPatchSchema + permission guard)
 * is the authoritative gate; client bounds are UX only.
 *
 * FE DoD: real post-method form with an inline preventDefault submit that calls
 * the mutation — never a GET-fallback submit.
 */
const SENDER_NAME_MAX = 120;

export function BrandingConfig() {
  const t = useTranslations('settings.branding');
  const canRead = useHasPermission('org.settings.read');
  const canWrite = useHasPermission('org.settings.update');

  const { data, isLoading, isError } = useOrgSettings({ enabled: canRead });
  const mutation = useUpdateOrgSettings();

  // Local draft of senderName, seeded from the resolved server value.
  const [senderName, setSenderName] = useState('');
  useEffect(() => {
    if (data) setSenderName(data.branding.senderName);
  }, [data]);

  if (!canRead) {
    return (
      <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-branding-h">
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

  const trimmed = senderName.trim();
  const inBounds = trimmed.length >= 1 && senderName.length <= SENDER_NAME_MAX;
  const dirty = data !== undefined && senderName !== data.branding.senderName;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWrite || !inBounds || !dirty) return;
    mutation.mutate({ branding: { senderName } });
  };

  return (
    <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-branding-h">
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
          <fieldset className="flex flex-col gap-2" disabled={!canWrite || mutation.isPending}>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
                {t('senderName')}
              </span>
              <input
                type="text"
                name="senderName"
                value={senderName}
                maxLength={SENDER_NAME_MAX}
                onChange={(e) => setSenderName(e.target.value)}
                className="rounded border px-2 py-1 text-sm"
                style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
              />
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {t('senderNameHint')}
              </span>
            </label>
          </fieldset>

          {!inBounds && (
            <p className="text-[11px]" role="alert" style={{ color: 'var(--danger-700)' }}>
              {t('senderNameRequired')}
            </p>
          )}

          {/* emailFrom — display-only, never patched (custom address deferred). */}
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
              {t('emailFrom')}
            </span>
            <input
              type="text"
              name="emailFrom"
              value={data.branding.emailFrom ?? ''}
              disabled
              readOnly
              dir="ltr"
              placeholder={t('emailFromPlaceholder')}
              className="rounded border px-2 py-1 text-sm"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {t('emailFromNote')}
            </span>
          </div>

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

function SectionHeading({ section }: { section: string }) {
  return (
    <h2
      id="set-branding-h"
      className="text-[11px] font-semibold uppercase tracking-wider"
      style={{ color: 'var(--text-muted)' }}
    >
      {section}
    </h2>
  );
}
