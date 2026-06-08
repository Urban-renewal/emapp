'use client';

import type { NotificationChannel } from '@emapp/shared-types';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useOrgSettings, useUpdateOrgSettings } from '@/hooks/use-org-settings';
import { useHasPermission } from '@/hooks/use-permissions';

/**
 * P6-1 — the per-org NOTIFICATIONS config section (the seam's first admin-
 * editable namespace). A `org.settings.update` holder toggles the default
 * delivery channels every notification fans out to; the value is read via
 * GET /api/v1/org/settings and written via PATCH (partial — only the
 * `notifications` namespace).
 *
 * Channels are a FREE PREFERENCE (no security floor — see the seam's SECURITY
 * FLOOR note), so there is no tighten-only clamp here; the BE accepts any valid
 * channel subset.
 *
 * AUTHZ (defense-in-depth UX): the read is gated on `org.settings.read` and the
 * write controls on `org.settings.update`. The BE is the authoritative gate; we
 * hide controls only so we never render a button that 403s.
 *
 * FE DoD: this is a real `<form method="post">` with an inline `onSubmit` that
 * `preventDefault()`s and calls the mutation — never a GET-fallback submit.
 */
const ALL_CHANNELS: readonly NotificationChannel[] = ['in_app', 'email', 'sms'];

export function NotificationsConfig() {
  const t = useTranslations('settings.notifications');
  const canRead = useHasPermission('org.settings.read');
  const canWrite = useHasPermission('org.settings.update');

  const { data, isLoading, isError } = useOrgSettings({ enabled: canRead });
  const mutation = useUpdateOrgSettings();

  // Local draft of the channel set, seeded from the resolved server value.
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  useEffect(() => {
    if (data) setChannels(data.notifications.defaultChannels);
  }, [data]);

  // A viewer/agent who reached this tab without the read permission sees the
  // descriptive blurb only (no data fetch, no controls).
  if (!canRead) {
    return (
      <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-notif-h">
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

  const toggle = (ch: NotificationChannel) => {
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]));
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canWrite || channels.length === 0) return;
    mutation.mutate({ notifications: { defaultChannels: channels } });
  };

  const dirty =
    data !== undefined &&
    (channels.length !== data.notifications.defaultChannels.length ||
      channels.some((c) => !data.notifications.defaultChannels.includes(c)));

  return (
    <section className="card card-pad flex flex-col gap-3" aria-labelledby="set-notif-h">
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
        <form method="post" onSubmit={onSubmit} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2" disabled={!canWrite || mutation.isPending}>
            <legend className="text-[12px] font-medium" style={{ color: 'var(--text)' }}>
              {t('channelsLegend')}
            </legend>
            {ALL_CHANNELS.map((ch) => (
              <label key={ch} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="defaultChannels"
                  value={ch}
                  checked={channels.includes(ch)}
                  onChange={() => toggle(ch)}
                  className="h-4 w-4"
                />
                <span style={{ color: 'var(--text)' }}>{t(`channel.${ch}`)}</span>
              </label>
            ))}
          </fieldset>

          {channels.length === 0 && (
            <p className="text-[11px]" role="alert" style={{ color: 'var(--danger-700)' }}>
              {t('atLeastOne')}
            </p>
          )}

          {canWrite ? (
            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={!dirty || channels.length === 0 || mutation.isPending}
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
      id="set-notif-h"
      className="text-[11px] font-semibold uppercase tracking-wider"
      style={{ color: 'var(--text-muted)' }}
    >
      {section}
    </h2>
  );
}
