'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { useProviderSystemHealth } from '@/hooks/use-provider';
import { cn } from '@/lib/utils';
import type { ProviderHealthSeverity } from '@/models/provider-health.vm';

/**
 * Provider Admin dashboard home — `/he/provider`.
 *
 * Surfaces the overall system-health gauge + quick links to the
 * deeper drill-downs. The single-gauge presentation keeps the first
 * render cheap and provides immediate operational signal.
 *
 * The severity → color mapping is intentionally NOT in the component
 * (a future StatusBadge refactor can absorb it). Locked palette
 * matches the rest of the FE: gray / amber / red.
 */
const SEVERITY_CLASS: Record<ProviderHealthSeverity, string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-800',
  crit: 'bg-red-100 text-red-800',
};

export default function ProviderDashboardPage() {
  const t = useTranslations('provider.dashboard');
  const tNav = useTranslations('provider.nav');
  const health = useProviderSystemHealth();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </header>

      <section className="rounded-md border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('healthTitle')}</h2>
        {health.isLoading && <ListSkeleton rows={1} />}
        {health.isError && <p className="text-sm text-destructive">{t('healthLoadFailed')}</p>}
        {health.data && (
          <div className="mt-2 flex items-center gap-3">
            <span
              className={cn(
                'inline-flex items-center rounded-full px-3 py-1 text-sm font-medium',
                SEVERITY_CLASS[health.data.overall],
              )}
              aria-label={t(`severity.${health.data.overall}`)}
            >
              {t(`severity.${health.data.overall}`)}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('healthAsOf', {
                when: health.data.timestamp.toLocaleString('he-IL', {
                  timeZone: 'Asia/Jerusalem',
                }),
              })}
            </span>
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Button asChild variant="outline">
          <Link href="/provider/tenants">{tNav('tenants')}</Link>
        </Button>
        {/* Phase 4b extension — audit + system-health pages now live. */}
        <Button asChild variant="outline">
          <Link href="/provider/audit">{tNav('audit')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/provider/system-health">{tNav('systemHealth')}</Link>
        </Button>
      </section>
    </div>
  );
}
