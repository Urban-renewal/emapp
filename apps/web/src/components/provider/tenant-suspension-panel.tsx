'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useReactivateTenant, useSuspendTenant } from '@/hooks/use-provider';
import { ApiClientError } from '@/lib/api/errors';
import { ProviderReasonRequiredError } from '@/lib/api/provider';
import type { ProviderTenantDetailVM } from '@/models/provider-tenant.vm';

/**
 * D.49 — Provider write actions on a tenant: suspend / reactivate.
 *
 * Security posture:
 *  - Both calls go through the audit-first `withProvider` BE path; the
 *    session `access_reason` (AccessReasonGate) is attached by the API
 *    client and lands on the forensic audit row. This panel never sends a
 *    request without that reason (the gate guarantees it; the client
 *    throws if it is somehow empty).
 *  - The optional operator `note` on suspend is the customer-facing reason
 *    persisted on the org (`suspended_reason`), distinct from the forensic
 *    access_reason. No PII is collected here.
 *  - Suspend is a freeze (reversible), NOT a destructive purge (out of
 *    scope per D.49). The confirm copy says so.
 *
 * UX: matches the app convention — the styled `useConfirm()` dialog for the
 * irreversible-feeling action + inline error state (no toast lib in this app).
 * Suspend reveals an inline optional-note field before confirming; reactivate
 * is a single styled confirm.
 */
interface Props {
  tenant: ProviderTenantDetailVM;
}

export function TenantSuspensionPanel({ tenant }: Props) {
  const t = useTranslations('provider.tenantDetail.suspension');
  const suspend = useSuspendTenant(tenant.id);
  const reactivate = useReactivateTenant(tenant.id);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const pending = suspend.isPending || reactivate.isPending;

  function describeError(e: unknown): string {
    // Anti-enumeration: a missing tenant or forbidden write surfaces a
    // generic failure — never leak which it was. The only specific case
    // is a missing access_reason, surfaced from BOTH the FE-local guard
    // (ProviderReasonRequiredError, code `reason_required_local`) and the
    // BE 400 (`reason_required`). The AccessReasonGate normally prevents
    // either from firing — this is defense in depth.
    if (e instanceof ProviderReasonRequiredError) return t('reasonRequired');
    if (e instanceof ApiClientError && e.code === 'reason_required') return t('reasonRequired');
    return t('actionFailed');
  }

  async function onConfirmSuspend() {
    setActionError(null);
    try {
      await suspend.mutateAsync({ note: note.trim() || undefined });
      setNoteOpen(false);
      setNote('');
    } catch (e) {
      setActionError(describeError(e));
    }
  }

  async function onReactivate() {
    setActionError(null);
    if (!(await confirm({ message: t('reactivateConfirm'), destructive: true }))) return;
    try {
      await reactivate.mutateAsync();
    } catch (e) {
      setActionError(describeError(e));
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-border bg-status-warning-bg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold">{t('title')}</h2>
          {tenant.isSuspended ? (
            <p className="text-sm text-status-warning-fg">
              {t('suspendedSince', { when: tenant.suspendedRelative ?? '' })}
              {tenant.suspendedReason ? ` — ${tenant.suspendedReason}` : ''}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('activeHint')}</p>
          )}
        </div>
        {tenant.isSuspended ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={onReactivate}>
            {reactivate.isPending ? t('reactivating') : t('reactivate')}
          </Button>
        ) : (
          !noteOpen && (
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => {
                setActionError(null);
                setNoteOpen(true);
              }}
            >
              {t('suspend')}
            </Button>
          )
        )}
      </div>

      {/* Inline suspend confirmation — optional operator note, then confirm.
          method=post + onSubmit/preventDefault so a JS-failure can't leak the
          note to the URL (FE DoD). */}
      {noteOpen && !tenant.isSuspended && (
        <form
          method="post"
          action=""
          onSubmit={(e) => {
            e.preventDefault();
            void onConfirmSuspend();
          }}
          className="space-y-2 border-t border-border pt-3"
        >
          <p className="text-sm text-status-warning-fg">{t('suspendConfirm')}</p>
          <label htmlFor="suspend-note" className="text-sm font-medium">
            {t('noteLabel')}
          </label>
          <textarea
            id="suspend-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder={t('notePlaceholder')}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" size="sm" disabled={pending}>
              {suspend.isPending ? t('suspending') : t('confirmSuspend')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setNoteOpen(false);
                setNote('');
                setActionError(null);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {confirmDialog}
    </section>
  );
}
