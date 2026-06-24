'use client';

/**
 * Share-activity / revoke panel — V13 X-S6/X-S7. Lists the org's ACTIVE
 * external-share grants (the BE `list` returns only non-revoked) with a LIVE
 * expiry countdown + last-activity, and per-row extend / resend / revoke driven
 * through the canonical `ConfirmDialog`. A revoke invalidates the list key and
 * the row disappears (the recipient's access dies) — verified end-to-end by the
 * lead's real-Chrome walk.
 *
 * Situation-picture, not a flat wall: rows are sorted EXPIRING-FIRST (and
 * already-expired float to the very top as "attention"), so at scale the things
 * that need a decision are on top. The headline countdown is the at-a-glance
 * status; one click confirms each lifecycle action.
 */
import { Clock, RefreshCw, Trash2, CalendarPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import type { ExternalShareViewModel } from '@/adapters/external-share';
import { useToast } from '@/components/ui/action-toast';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { DataState } from '@/components/ui/data-state';
import { useExternalShareList } from '@/hooks/external-share-list';
import {
  useExtendExternalShare,
  useResendExternalShare,
  useRevokeExternalShare,
} from '@/hooks/external-share-mutations';

/** Default extend bump (30d forward) — the BE caps it at the ceiling TTL. */
const EXTEND_DAYS = 30;
const COUNTDOWN_TICK_MS = 1000;

export function ShareActivityPanel({ enabled = true }: { enabled?: boolean } = {}) {
  const t = useTranslations('externalShare');
  const { data, isLoading, isError, refetch } = useExternalShareList({ limit: 50 }, { enabled });

  // One ticking clock for the whole panel (avoids N intervals).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const rows = useMemo(() => {
    const items = data?.items ?? [];
    // Expiring-first: no-expiry last, soonest-to-expire (incl. already-expired) first.
    return [...items].sort((a, b) => {
      const am = a.msUntilExpiry;
      const bm = b.msUntilExpiry;
      if (am === null && bm === null) return 0;
      if (am === null) return 1;
      if (bm === null) return -1;
      return am - bm;
    });
  }, [data?.items]);

  return (
    <DataState
      isLoading={isLoading}
      isError={isError}
      error={undefined}
      isEmpty={Boolean(data && rows.length === 0)}
      onRetry={() => void refetch()}
      skeleton="list"
      emptyTitle={t('activity.empty')}
      emptyHint={t('activity.emptyHint')}
    >
      <ul className="flex flex-col gap-2" aria-label={t('activity.heading')}>
        {rows.map((s) => (
          <li key={s.id}>
            <ShareRow share={s} now={now} />
          </li>
        ))}
      </ul>
    </DataState>
  );
}

function ShareRow({ share, now }: { share: ExternalShareViewModel; now: number }) {
  const t = useTranslations('externalShare');
  const tParty = useTranslations('externalShare.party');
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const extend = useExtendExternalShare();
  const resend = useResendExternalShare();
  const revoke = useRevokeExternalShare();

  const busy = extend.isPending || resend.isPending || revoke.isPending;

  // Live countdown from the ticking `now` (not the VM seed, which is one fetch old).
  const msLeft = share.expiresAtIso ? new Date(share.expiresAtIso).getTime() - now : null;
  const expired = msLeft !== null && msLeft <= 0;

  const countdown = (() => {
    if (msLeft === null) return t('countdown.noExpiry');
    if (expired) return t('countdown.expired');
    return t('countdown.remaining', { duration: humanizeDuration(msLeft, t) });
  })();

  async function onRevoke() {
    if (busy) return;
    if (
      !(await confirm({
        message: t('revokeConfirm', { party: tParty(share.partyType) }),
        destructive: true,
      }))
    )
      return;
    try {
      await revoke.mutateAsync(share.id);
      toast.show({ message: t('revokeDone') });
    } catch {
      toast.show({ message: t('revokeFailed'), variant: 'assertive' });
    }
  }

  async function onExtend() {
    if (busy) return;
    if (!(await confirm({ message: t('extendConfirm', { days: EXTEND_DAYS }) }))) return;
    // Forward-only: extend from whichever is later (now or current expiry) + bump.
    const base =
      msLeft !== null && msLeft > 0 ? new Date(share.expiresAtIso as string).getTime() : now;
    const expiresAt = new Date(base + EXTEND_DAYS * 24 * 60 * 60 * 1000);
    try {
      await extend.mutateAsync({ id: share.id, body: { expiresAt } });
      toast.show({ message: t('extendDone') });
    } catch {
      // The BE caps at the ceiling TTL and rejects a backward move — surface
      // a clean failure rather than swallowing it.
      toast.show({ message: t('extendFailed'), variant: 'assertive' });
    }
  }

  async function onResend() {
    if (busy) return;
    try {
      await resend.mutateAsync(share.id);
      toast.show({ message: t('resendDone', { party: tParty(share.partyType) }) });
    } catch {
      toast.show({ message: t('resendFailed'), variant: 'assertive' });
    }
  }

  return (
    <div
      className="card flex flex-col gap-2 px-3.5 py-3"
      style={expired ? { borderColor: 'var(--warning-600)' } : undefined}
      data-testid="share-row"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-foreground">
            {tParty(share.partyType)}
          </span>
          <span className="truncate text-xs text-text-soft">
            {t('row.scope', {
              count: share.scopeCount,
              type: t(`scopeType.${share.scopeType}`),
            })}{' '}
            · {t('row.perms', { summary: share.permissionSummary })}
          </span>
        </div>
        <span
          className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
          style={{
            background: expired ? 'var(--warning-50, var(--bg-subtle))' : 'var(--bg-surface)',
            color: expired ? 'var(--warning-700, var(--text-muted))' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
          data-testid="share-row-countdown"
        >
          <Clock className="h-3 w-3" aria-hidden="true" />
          {countdown}
        </span>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-text-soft">
          {t('row.lastActivity', { when: share.lastActivityRelative })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onResend}
            disabled={busy}
            aria-busy={resend.isPending}
            aria-label={t('row.resendAria', { party: tParty(share.partyType) })}
            data-testid="share-row-resend"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-xs">{t('row.resend')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onExtend}
            disabled={busy}
            aria-busy={extend.isPending}
            aria-label={t('row.extendAria', { party: tParty(share.partyType) })}
            data-testid="share-row-extend"
          >
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-xs">{t('row.extend')}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRevoke}
            disabled={busy}
            aria-busy={revoke.isPending}
            aria-label={t('row.revokeAria', { party: tParty(share.partyType) })}
            data-testid="share-row-revoke"
            className="text-danger-600"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="text-xs">{t('row.revoke')}</span>
          </Button>
        </div>
      </div>
      {dialog}
    </div>
  );
}

/** Coarse human countdown ("3 ימים" / "5 שעות" / "12 דקות"). Pure; the unit
 *  strings come from i18n so it stays Hebrew-first + RTL-correct. */
function humanizeDuration(ms: number, t: ReturnType<typeof useTranslations>): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  if (days >= 1) return t('countdown.days', { count: days });
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 1) return t('countdown.hours', { count: hours });
  const minutes = Math.max(1, totalMinutes);
  return t('countdown.minutes', { count: minutes });
}
