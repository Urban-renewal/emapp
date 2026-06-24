'use client';

/**
 * Share-sheet — the "invite a party" (SHARE-TO) create+send surface
 * (V13 X-S6/X-S7). The documents-process Collaboration verb: a manager grants a
 * developer / lawyer / bank / appraiser / … a NARROWED-from-ceiling read over a
 * project / building / apartment.
 *
 * Flow (autonomous-minimum-actions):
 *   1. pick a party-chip → the server-owned preset CEILING AUTO-FILLS scope +
 *      permissions + a conservative TTL (`presetDefaultFor`);
 *   2. the manager may only NARROW — toggles the ceiling forbids are DISABLED
 *      (greyed), and turning OFF a section is always allowed. The FE never
 *      widens; the server re-validates fail-closed regardless;
 *   3. one tap creates + (the BE resend/delivery seam) sends.
 *
 * Sensitive scope (issue 486 caveat): sensitive-document external delivery
 * still rides the unmerged plaintext-at-rest gap (PR 498). This slice is NON-
 * sensitive ONLY. `allowSensitive` is HARD-FORCED false on the wire and the
 * toggle is shown DISABLED with an explicit "blocked — coming later" note — it
 * is never silently sent. (When PR 498 lands, the StepUp gate wires in here:
 * enabling sensitive will route through `useStepUpUnlock` before create.)
 *
 * Mounts as a modal (mirrors StepUpDialog / ConfirmDialog — fixed overlay,
 * click-dismiss, ESC). `useShareSheet()` owns the open state so a caller mounts
 * one `<button>` + `{sheet}` (ADDITIVE — no host refactor).
 */
import type {
  CreateExternalShare,
  ExternalSharePartyType,
  ExternalSharePermissions,
  ExternalShareScopeType,
} from '@emapp/shared-types';
import { Send, ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  EXTERNAL_SHARE_PARTY_TYPES,
  FE_PARTY_CEILINGS,
  presetDefaultFor,
} from '@/adapters/external-share';
import { useToast } from '@/components/ui/action-toast';
import { Button } from '@/components/ui/button';
import { useCreateExternalShare } from '@/hooks/external-share-mutations';
import { ApiClientError } from '@/lib/api/errors';

/** The scope a sheet is opened FOR — supplied by the mount point (e.g. a project
 *  drill-down passes `{ scopeType: 'project', scopeIds: [projectId], label }`).
 *  The party preset may narrow the scope_type, but never widen past this. */
export interface ShareScope {
  scopeType: ExternalShareScopeType;
  scopeIds: string[];
  /** Human label for the thing being shared (project / building / apartment). */
  label: string;
}

export interface UseShareSheet {
  open: (scope: ShareScope) => void;
  sheet: ReactNode;
}

/** Coarse BE ceiling-rejection codes → a single clean inline message (the FE
 *  must NOT silently swallow a 403; G-RT). */
const CEILING_REJECT_CODES = new Set(['exceeds_ceiling', 'cannot_widen', 'invalid_scope']);

export function useShareSheet(): UseShareSheet {
  const [scope, setScope] = useState<ShareScope | null>(null);
  const open = useCallback((s: ShareScope) => setScope(s), []);
  const close = useCallback(() => setScope(null), []);
  const sheet = scope ? <ShareSheet scope={scope} onClose={close} /> : null;
  return { open, sheet };
}

function ShareSheet({ scope, onClose }: { scope: ShareScope; onClose: () => void }) {
  const t = useTranslations('externalShare');
  const tParty = useTranslations('externalShare.party');
  const toast = useToast();
  const create = useCreateExternalShare();

  const [partyType, setPartyType] = useState<ExternalSharePartyType | null>(null);
  const [permissions, setPermissions] = useState<ExternalSharePermissions | null>(null);
  const [ttlDays, setTtlDays] = useState<number>(30);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ceiling = partyType ? FE_PARTY_CEILINGS[partyType] : null;

  function choosePartyType(pt: ExternalSharePartyType) {
    setPartyType(pt);
    setError(null);
    const preset = presetDefaultFor(pt);
    setPermissions(preset.permissions);
    setTtlDays(preset.ttlDays);
  }

  // NARROW-ONLY toggles: a section may always be turned OFF; it may be turned ON
  // only if the ceiling permits (so the FE physically cannot widen past the
  // preset). Download requires documents.on (schema coherence).
  function toggleSection(section: 'overview' | 'documents' | 'signatures') {
    if (!permissions || !ceiling) return;
    const next: ExternalSharePermissions = JSON.parse(JSON.stringify(permissions));
    const turningOn = !next[section].on;
    if (turningOn && !ceiling.permissions[section].on) return; // ceiling forbids — no-op
    next[section].on = turningOn;
    if (section === 'documents' && !turningOn) next.documents.actions.download = false;
    setPermissions(next);
  }

  function toggleDownload() {
    if (!permissions || !ceiling) return;
    const next: ExternalSharePermissions = JSON.parse(JSON.stringify(permissions));
    const turningOn = !next.documents.actions.download;
    if (turningOn && (!ceiling.permissions.documents.actions.download || !next.documents.on))
      return;
    next.documents.actions.download = turningOn;
    setPermissions(next);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!partyType || !permissions || create.isPending) return;
    setError(null);

    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    const body: CreateExternalShare = {
      partyType,
      scopeType: scope.scopeType,
      scopeIds: scope.scopeIds,
      permissions,
      // issue-486 caveat — NON-sensitive only this slice. Hard-forced false;
      // the toggle is disabled in the UI. Never silently send sensitive.
      allowSensitive: false,
      otpRequired: true,
      expiresAt,
    };

    try {
      await create.mutateAsync(body);
      toast.show({ message: t('createdSent', { party: tParty(partyType) }) });
      onClose();
    } catch (err) {
      // Do NOT swallow a 403/400 ceiling rejection — surface it cleanly (G-RT).
      if (err instanceof ApiClientError && CEILING_REJECT_CODES.has(err.code)) {
        setError(t('error.ceiling'));
        return;
      }
      if (err instanceof ApiClientError && err.code === 'forbidden') {
        setError(t('error.forbidden'));
        return;
      }
      setError(t('error.generic'));
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-sheet-title"
      data-testid="share-sheet"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        className="relative z-10 flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-lg border bg-card p-6 text-start shadow-lg"
      >
        <div className="flex flex-col gap-1">
          <h2 id="share-sheet-title" className="text-lg font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="text-sm text-text-muted">{t('subtitle', { scope: scope.label })}</p>
        </div>

        {/* Step 1 — party chip select (auto-fills the preset on click). */}
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-text-muted">{t('partyLegend')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {EXTERNAL_SHARE_PARTY_TYPES.map((pt) => {
              const isActive = partyType === pt;
              return (
                <button
                  key={pt}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => choosePartyType(pt)}
                  data-testid={`share-sheet-party-${pt}`}
                  className="rounded-full px-2.5 py-1 text-xs font-medium transition-colors"
                  style={{
                    background: isActive ? 'var(--text)' : 'var(--bg-surface)',
                    color: isActive ? 'var(--bg-surface)' : 'var(--text-muted)',
                    border: isActive ? 'none' : '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  {tParty(pt)}
                </button>
              );
            })}
          </div>
        </fieldset>

        {partyType && permissions && ceiling && (
          <form method="post" onSubmit={onSubmit} className="flex flex-col gap-4">
            {/* Scope (read-only — fixed by the mount point). */}
            <div className="rounded-md bg-surface-subtle px-3 py-2 text-xs text-text-muted">
              {t('scopeLine', { scope: scope.label, type: t(`scopeType.${scope.scopeType}`) })}
            </div>

            {/* Step 2 — permission toggles (narrow-only; ceiling-forbidden = disabled). */}
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-medium text-text-muted">{t('permsLegend')}</legend>
              <PermToggle
                label={t('perm.overview')}
                checked={permissions.overview.on}
                disabled={!ceiling.permissions.overview.on}
                onToggle={() => toggleSection('overview')}
                testid="share-sheet-perm-overview"
              />
              <PermToggle
                label={t('perm.documents')}
                checked={permissions.documents.on}
                disabled={!ceiling.permissions.documents.on}
                onToggle={() => toggleSection('documents')}
                testid="share-sheet-perm-documents"
              />
              <PermToggle
                label={t('perm.download')}
                checked={permissions.documents.actions.download}
                disabled={
                  !ceiling.permissions.documents.actions.download || !permissions.documents.on
                }
                onToggle={toggleDownload}
                indent
                testid="share-sheet-perm-download"
              />
              <PermToggle
                label={t('perm.signatures')}
                checked={permissions.signatures.on}
                disabled={!ceiling.permissions.signatures.on}
                onToggle={() => toggleSection('signatures')}
                testid="share-sheet-perm-signatures"
              />
            </fieldset>

            {/* Sensitive — BLOCKED this slice (issue 486). Disabled + explicit note. */}
            <div
              className="flex items-start gap-2 rounded-md px-3 py-2 text-xs"
              style={{ background: 'var(--warning-50, var(--bg-subtle))' }}
              data-testid="share-sheet-sensitive-blocked"
            >
              <ShieldAlert
                className="mt-0.5 h-4 w-4 shrink-0"
                style={{ color: 'var(--warning-700, var(--text-muted))' }}
                aria-hidden="true"
              />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-foreground">{t('sensitive.blockedTitle')}</span>
                <span className="text-text-muted">{t('sensitive.blockedHint')}</span>
              </div>
            </div>

            {/* TTL — bounded by the party ceiling. */}
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-text-muted">{t('ttlLabel')}</span>
              <select
                value={ttlDays}
                onChange={(e) => setTtlDays(Number(e.target.value))}
                className="input"
                data-testid="share-sheet-ttl"
              >
                {ttlOptions(ceiling.maxTtlDays).map((d) => (
                  <option key={d} value={d}>
                    {t('ttlDays', { count: d })}
                  </option>
                ))}
              </select>
            </label>

            {error && (
              <p
                role="alert"
                data-testid="share-sheet-error"
                className="text-sm"
                style={{ color: 'var(--danger-700)' }}
              >
                {error}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={create.isPending}
                aria-busy={create.isPending}
                data-testid="share-sheet-submit"
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{create.isPending ? t('sending') : t('createSend')}</span>
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** TTL choices, clamped to the party ceiling cap. */
function ttlOptions(maxTtlDays: number | null): number[] {
  const base = [7, 14, 30, 90, 180, 365];
  return maxTtlDays === null ? base : base.filter((d) => d <= maxTtlDays);
}

function PermToggle({
  label,
  checked,
  disabled,
  onToggle,
  indent = false,
  testid,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  indent?: boolean;
  testid: string;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-2 text-sm ${indent ? 'ps-4' : ''}`}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <span className="text-foreground">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        data-testid={testid}
        className="h-4 w-4"
      />
    </label>
  );
}
