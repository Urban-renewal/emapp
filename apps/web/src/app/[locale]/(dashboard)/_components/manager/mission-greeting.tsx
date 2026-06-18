'use client';

import { useTranslations } from 'next-intl';

import { NameDisplay } from '@/components/ui/name-display';

/**
 * MissionGreeting — the warm greeting + one-line plain-Hebrew summary at the
 * top of the manager home (north-star principle 2 + the emotional target:
 * "open → I instantly see where I stand").
 *
 * Presentational + token-themed. `timeOfDay` is computed by the parent island
 * (it needs the client clock) and maps to a greeting key, so this component
 * stays pure. `exceptionCount` drives the summary sentence:
 *   - 0  → "הכול תחת שליטה. כל הפרויקטים מתקדמים יפה." (calm)
 *   - >0 → "{n} דברים דורשים אותך היום. שאר הפרויקטים מתקדמים יפה."
 *
 * The number is REAL — it is the count of exception items the triage computed
 * from live project data (never fabricated).
 */
export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export function MissionGreeting({
  name,
  timeOfDay,
  exceptionCount,
}: {
  name: string;
  timeOfDay: TimeOfDay;
  exceptionCount: number;
}) {
  const t = useTranslations('home.manager.greeting');
  const trimmed = name.trim();

  return (
    <div>
      <h1 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>
        {trimmed ? (
          <>
            {t(timeOfDay)}, <NameDisplay name={trimmed} />
          </>
        ) : (
          t(`${timeOfDay}NoName`)
        )}
      </h1>
      <p className="mt-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>
        {exceptionCount > 0 ? t('summaryWithExceptions', { n: exceptionCount }) : t('summaryCalm')}
      </p>
    </div>
  );
}
