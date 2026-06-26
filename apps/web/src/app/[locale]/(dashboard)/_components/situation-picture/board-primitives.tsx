'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BellRing, CheckCircle2, Send, Users } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { useToast } from '@/components/ui/action-toast';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { ThresholdSliver } from '@/components/ui/threshold-progress';
import {
  isPermissionDenied,
  useApartmentHoldouts,
  useSignatureProgressApartments,
} from '@/hooks/use-projects';
import {
  HOLDOUT_NONE_PENDING_CODE,
  useChaseHoldout,
  type HoldoutChaseResult,
} from '@/hooks/use-signature-requests';
import { apiClient, isOk } from '@/lib/api-client';
import type { ApartmentHoldoutViewModel } from '@/models/apartment-signature-progress.vm';
import type {
  FleetProjectViewModel,
  FleetState,
  PulseActionCardViewModel,
} from '@/models/signature-pulse.vm';

/**
 * Situation-picture board primitives — the ONE source of truth for the
 * board-first pattern (Tier-0 pulse sentence → Tier-1 ranked attention
 * ActionCards w/ holdout drill-down + one-click chase → Tier-2 fleet tiles).
 *
 * Extracted VERBATIM from `mission-control-home.tsx` (E2.1/#44) so the
 * signatures situation-picture (signature-requests redesign Slice 1) REUSES the
 * exact same primitives rather than duplicating them (avoids the 59-site dup
 * debt). `mission-control-home.tsx` now imports + re-exports from here; its
 * behaviour and tests stay byte-identical.
 *
 * All copy comes from the `home.pulse` next-intl namespace — the pulse copy is
 * already signature-centric ("פרויקט תקוע", "חתימות פגות"), so it reads
 * correctly on BOTH the home and the signatures surface with no fork.
 *
 * Token-only styling: EMAPP semantic classes (`text-foreground`,
 * `text-text-muted`, `.card`, `.badge`, `.btn`) — no inline color literal, no
 * default palette. RTL-first via logical props. PII (holdout names) loads ONLY
 * on demand through the gated + audited B4 endpoint; every name is wrapped in
 * <NameDisplay> (bidi-spoof defence, §v9-H-3).
 */

// ── Tier-2 fleet ────────────────────────────────────────────────────────────

/**
 * NS-Fleet — the full-fleet "כל הפרויקטים" situation-picture section.
 *
 * A calm, responsive grid of compact tiles, one per in-scope project (server
 * order preserved — most-urgent first). Each tile is a zoom-in <Link> to the
 * project, carrying its signature-state chip + a thin consent sliver + the %
 * text. Projects that also appear as attention cards above are subtly marked
 * (a quiet "במעקב" note) but NEVER hidden — the whole fleet stays visible.
 *
 * Scale (5→500): the adapter caps the tiles at `FLEET_TILE_CAP`; when the org
 * has more, `fleetCapped` is true and the heading offers a "הצג הכל" link to the
 * full /projects list rather than rendering hundreds of tiles into the surface.
 */
export function FleetSection({
  fleet,
  fleetCapped,
  totalInScope,
  headingId = 'situation-picture-fleet',
}: {
  fleet: FleetProjectViewModel[];
  fleetCapped: boolean;
  totalInScope: number;
  /** Distinct id so two boards (home + signatures) never collide on the same page. */
  headingId?: string;
}) {
  const t = useTranslations('home.pulse');

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          {t('fleet.heading', { count: totalInScope })}
        </h2>
        {/* Scale escape-hatch — when the fleet is capped, the full list lives on
            the projects page (this surface stays calm-at-a-glance). */}
        {fleetCapped && (
          <Link
            href="/projects"
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-foreground"
          >
            <span>{t('fleet.showAll')}</span>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {fleet.map((p) => (
          <li key={p.projectId}>
            <FleetTile tile={p} t={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One compact, calm fleet tile — a zoom-in link to the project carrying its
 *  signature-state chip + consent sliver + % text. Presentational; the adapter
 *  already derived the state/intent. */
export function FleetTile({
  tile,
  t,
}: {
  tile: FleetProjectViewModel;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Link
      href={`/projects/${tile.projectId}`}
      className="card card-pad flex flex-col gap-2 transition-colors hover:bg-surface-subtle"
      aria-label={t('fleet.openAria', { name: tile.projectName })}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          <NameDisplay name={tile.projectName} />
        </span>
        <StatusBadge intent={tile.intent} className="shrink-0">
          {buildFleetTag(t, tile.state)}
        </StatusBadge>
      </div>

      {/* The thin consent sliver — at-a-glance progress, reusing HB-4's primitive. */}
      <ThresholdSliver consentedPct={tile.consentedPct} metThreshold={tile.metThreshold} />

      <div className="flex items-center justify-between gap-2">
        <span className="tabular text-xs text-text-muted" dir="ltr">
          {t('consentPct', { pct: tile.consentedPct })}
        </span>
        {/* A project also on the attention board above is quietly marked here —
            never hidden (the whole fleet stays visible). */}
        {tile.isOnBoard && <span className="text-xs text-text-muted">{t('fleet.onBoard')}</span>}
      </div>
    </Link>
  );
}

/** The short signature-state TAG for a fleet tile's chip. Literal `t()` keys
 *  (not a template) so the i18n-coverage guard can verify them. */
export function buildFleetTag(t: ReturnType<typeof useTranslations>, state: FleetState): string {
  switch (state) {
    case 'stalled':
      return t('reason.stalled.tag');
    case 'expiring':
      return t('reason.expiring.tag');
    case 'notStarted':
      return t('reason.notStarted.tag');
    case 'met':
      return t('fleet.state.met');
    case 'onTrack':
      return t('fleet.state.onTrack');
    case 'consentGap':
    default:
      return t('reason.consentGap.tag');
  }
}

// ── Tier-1 ranked attention ActionCard ──────────────────────────────────────

/** A single ranked attention card. Presentational — every derivation already
 *  happened in the adapter; this only lays out the WHY + the action. */
export function ActionCard({
  card,
  canRemind,
  sendEnabled,
  t,
  basisLabel,
}: {
  card: PulseActionCardViewModel;
  canRemind: boolean;
  /** HB-1 kill-switch state (from the pulse). `false` → the remind action is
   *  pre-disabled with calm explanatory copy (belt-and-suspenders with the BE
   *  503), so the manager never taps into a guaranteed failure. */
  sendEnabled: boolean;
  t: ReturnType<typeof useTranslations>;
  basisLabel: string;
}) {
  return (
    <article className="card card-pad flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <StatusBadge intent={card.intent}>{buildTag(t, card)}</StatusBadge>
            <span className="truncate text-sm font-medium text-foreground">
              <NameDisplay name={card.projectName} />
            </span>
          </div>
          {/* The plain-Hebrew "why" — the system reporting what it found. */}
          <p className="text-sm text-text-muted">{buildWhy(t, card)}</p>
          {/* Consent % ALWAYS carries the basis label — never a bare legal %. */}
          <p className="text-xs text-text-muted">
            <span className="tabular" dir="ltr">
              {t('consentPct', { pct: card.consentedPct })}
            </span>
            <span className="ms-1">· {basisLabel}</span>
          </p>
          {/* HB-4 — the compact at-a-glance consent sliver. A thin, calm fill
              under the % text (success once the line is crossed, amber otherwise),
              reusing the board's ThresholdProgress tokens. The card has no full
              bar today; this adds the visual-at-a-glance the % text alone can't. */}
          <ThresholdSliver consentedPct={card.consentedPct} metThreshold={card.metThreshold} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Primary action: open the project (read-navigation — always safe). */}
          <Link
            href={`/projects/${card.projectId}`}
            className="btn btn-secondary btn-sm"
            aria-label={t('action.openAria', { name: card.projectName })}
          >
            <span>{t('action.open')}</span>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          {/* HB-5 — state-aware secondary action (mutating track, Viewer hidden):
              • campaign ACTIVE  → the project-wide one-tap "remind pending".
              • NO campaign yet  → "התחל איסוף חתימות" (a Link to the project,
                where the campaign is started) — never a dead-end remind. */}
          {canRemind &&
            (card.hasCampaign ? (
              <RemindButton
                projectId={card.projectId}
                projectName={card.projectName}
                sendEnabled={sendEnabled}
                t={t}
              />
            ) : (
              <Link
                href={`/projects/${card.projectId}`}
                className="btn btn-primary btn-sm"
                aria-label={t('action.startCampaignAria', { name: card.projectName })}
              >
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('action.startCampaign')}</span>
              </Link>
            ))}
        </div>
      </div>

      {/* HB-3/HB-5 — the inline "מי תקוע?" holdout-name expander. Collapsed by
          default; its NAMES (PII) load ON DEMAND from the gated + audited B4
          endpoint only when opened — the same gate/mask contract as the
          project-detail drill-down, never widened. The per-name action is
          state-aware (resend/create-against-the-apartment-doc vs start-campaign)
          and gated on `canRemind` + the holdout's own per-apartment signable doc. */}
      <HoldoutExpander projectId={card.projectId} canRemind={canRemind} sendEnabled={sendEnabled} />
    </article>
  );
}

// ── HB-3 holdout drill-down ─────────────────────────────────────────────────

/**
 * HB-3 — the board-card "מי תקוע?" (who's stuck?) holdout-name expander.
 *
 * Collapsed by default (calm disclosure; a real <button aria-expanded>, keyboard-
 * operable). On first open it lazily loads the project's per-apartment signature
 * progress (`useSignatureProgressApartments`, gated on `open`); for each NOT-fully-
 * consented apartment it reveals the holdout owner NAMES via the `view_owner_pii`-
 * gated + AUDITED B4 endpoint (`useApartmentHoldouts`, also gated on `open`). This
 * is the EXACT contract the project-detail drill-down uses — no new PII exposure:
 *   - a viewer / PII-less agent hits the BE 403 → the no-name FALLBACK line
 *     ("דירה N · חלקי"), never a raw name. (B4 hard-403s; there is no masked path.)
 *   - every name is wrapped in <NameDisplay> (bidi-spoof defence, §v9-H-3).
 *   - the per-access audit fires only when a manager deliberately opens a row.
 *
 * Each holdout row carries the name + apartment context + a per-name single
 * "שלח תזכורת" (only when `canRemind` — Viewer never sees it). Empty (0 holdouts)
 * shows the calm "אין חותמים תקועים", never a bare list. No layout shift: the
 * collapsed state is one button; the panel mounts below on expand.
 */
export function HoldoutExpander({
  projectId,
  canRemind,
  sendEnabled,
}: {
  projectId: string;
  canRemind: boolean;
  sendEnabled: boolean;
}) {
  const t = useTranslations('home.pulse');
  const [open, setOpen] = useState(false);
  const panelId = `holdouts-${projectId}`;

  const apartments = useSignatureProgressApartments(projectId, open);

  // The apartments worth chasing — anything not fully consented has ≥1 holdout.
  // Stable identity across renders so the child holdout queries don't churn.
  const pendingApartments = useMemo(
    () => (apartments.data ?? []).filter((a) => a.status !== 'consented'),
    [apartments.data],
  );

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-text-muted hover:text-foreground"
      >
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        {open ? t('holdouts.toggleHide') : t('holdouts.toggleShow')}
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-2">
          {apartments.isLoading && (
            <p className="text-xs text-text-muted">{t('holdouts.loading')}</p>
          )}

          {apartments.isError && (
            <div className="flex items-start gap-2">
              <p className="text-xs text-danger-700">{t('holdouts.loadFailed')}</p>
              <button
                type="button"
                onClick={() => void apartments.refetch()}
                className="text-xs font-medium text-text-muted hover:text-foreground"
              >
                {t('holdouts.retry')}
              </button>
            </div>
          )}

          {/* No apartment needs chasing → the calm "no one's stuck" reward line. */}
          {!apartments.isLoading &&
            !apartments.isError &&
            apartments.data &&
            pendingApartments.length === 0 && (
              <p className="text-xs text-text-muted">{t('holdouts.none')}</p>
            )}

          {pendingApartments.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {pendingApartments.map((apt) => (
                <HoldoutApartment
                  key={apt.apartmentId}
                  projectId={projectId}
                  apartmentId={apt.apartmentId}
                  apartmentNumber={apt.number}
                  canRemind={canRemind}
                  sendEnabled={sendEnabled}
                  t={t}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One not-fully-consented apartment's holdout NAMES, loaded on demand from the
 * gated + audited B4 endpoint. NEVER a bare null — every non-happy state is an
 * explicit calm treatment:
 *   - 403 (no `view_owner_pii`) → the no-name FALLBACK ("דירה N · חלקי"), terminal
 *     (a retry won't grant the capability), no name revealed.
 *   - generic error → calm retry.
 *   - empty → suppressed (the apartment is "partial" only because of an in-flight
 *     mismatch; render nothing rather than a misleading "0 stuck" per apartment —
 *     the parent's project-level "none" copy is the honest empty signal).
 */
export function HoldoutApartment({
  projectId,
  apartmentId,
  apartmentNumber,
  canRemind,
  sendEnabled,
  t,
}: {
  projectId: string;
  apartmentId: string;
  apartmentNumber: string;
  canRemind: boolean;
  sendEnabled: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const { data, isLoading, isError, error, refetch } = useApartmentHoldouts(projectId, apartmentId);
  const forbidden = isError && isPermissionDenied(error);

  if (isLoading) {
    return <li className="text-xs text-text-muted">{t('holdouts.loading')}</li>;
  }

  // 403 → no-name fallback: number + partial state, NO name. Terminal.
  if (forbidden) {
    return (
      <li className="text-xs text-text-muted">
        {t('holdouts.fallback', { number: apartmentNumber })}
      </li>
    );
  }

  if (isError) {
    return (
      <li className="flex items-center gap-2 text-xs">
        <span className="text-danger-700">{t('holdouts.loadFailed')}</span>
        <button
          type="button"
          onClick={() => void refetch()}
          className="font-medium text-text-muted hover:text-foreground"
        >
          {t('holdouts.retry')}
        </button>
      </li>
    );
  }

  if (!data || data.length === 0) return null;

  return (
    <>
      {data.map((holdout) => (
        <HoldoutRow
          key={holdout.ownerId}
          holdout={holdout}
          projectId={projectId}
          canRemind={canRemind}
          sendEnabled={sendEnabled}
          t={t}
        />
      ))}
    </>
  );
}

/**
 * One holdout owner row: the masked-or-named owner + apartment context + (gated)
 * a STATE-AWARE per-name action. The name is wrapped in <NameDisplay> (bidi
 * defence) or, for a name-less shell owner, the anonymous label.
 *
 * HB-5 — the per-name action is one click but state-aware:
 *   • campaign ACTIVE (`hasCampaign`): the chase resolves THIS owner's pending
 *     request and RESENDS it; if there is none it CREATES a request against the
 *     project's campaign document (the existing gated create) — never a
 *     dead-end. The action-toast reads "reminder sent" (resent) vs "signature
 *     request sent" (created).
 *   • NO campaign: there is nothing to collect against, so the action is a Link
 *     to the project to "start collecting signatures" — not a dead-end remind.
 */
export function HoldoutRow({
  holdout,
  projectId,
  canRemind,
  sendEnabled,
  t,
}: {
  holdout: ApartmentHoldoutViewModel;
  projectId: string;
  canRemind: boolean;
  sendEnabled: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const toast = useToast();
  const chase = useChaseHoldout();

  const disabled = !sendEnabled || chase.isPending;
  const ownerLabel = holdout.name ?? t('holdouts.noName');
  // HB-5 fix — gate the per-name chase on THIS holdout's OWN per-apartment
  // signable doc (not the project-wide campaign doc). Signing is per-apartment,
  // so the create targets the apartment the holdout actually owns → an associated
  // owner gets 201 (vs the old project-wide doc that 409'd `recipient_not_
  // associated` for holdouts in any other apartment). null ⇒ no apartment/project
  // agreement to collect against → the calm "start collection" guidance Link.
  const signableDocumentId = holdout.signableDocumentId;

  return (
    <li className="flex items-center justify-between gap-2 rounded-md bg-surface-subtle px-2.5 py-1.5">
      <span className="min-w-0 truncate text-xs text-text">
        {holdout.name ? (
          <NameDisplay name={holdout.name} />
        ) : (
          <span className="text-text-muted">{ownerLabel}</span>
        )}
        <span className="ms-1 text-text-muted">
          · {t('holdouts.apartment', { number: holdout.apartmentNumber })}
        </span>
      </span>

      {/* Per-name action — only for actors who may send (Viewer never sees it). */}
      {canRemind &&
        (signableDocumentId ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm shrink-0"
            disabled={disabled}
            aria-disabled={disabled}
            aria-busy={chase.isPending}
            aria-label={t('holdouts.remindAria', { name: ownerLabel })}
            title={!sendEnabled ? t('action.remindDisabled') : undefined}
            onClick={() => {
              if (disabled) return;
              chase.mutate(
                { ownerId: holdout.ownerId, signableDocumentId },
                {
                  onSuccess: ({ action, delivered }: HoldoutChaseResult) => {
                    // HONEST OUTCOME (delivery-outcome bug #2): the request always
                    // exists now, but the toast claims "sent" ONLY when a channel
                    // actually carried the link. A no-channel owner (no email AND
                    // no phone, or PII decrypt failed) gets a calm "created but not
                    // delivered — send the link manually" line + assertive tone, so
                    // the manager never believes a silent non-send went out.
                    if (!delivered) {
                      toast.show({
                        message: t('holdouts.requestNotDelivered', { name: ownerLabel }),
                        variant: 'assertive',
                      });
                      return;
                    }
                    toast.show({
                      message:
                        action === 'created'
                          ? t('holdouts.requestSent', { name: ownerLabel })
                          : t('holdouts.remindSent'),
                    });
                  },
                  onError: (err) => {
                    toast.show({
                      message: buildHoldoutRemindErrorMessage(t, err),
                      variant: 'assertive',
                    });
                  },
                },
              );
            }}
          >
            <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{chase.isPending ? t('action.remindPending') : t('action.remind')}</span>
          </button>
        ) : (
          // No signable doc for this apartment/project — route to where collection
          // is started, never a dead-end (and never a 409).
          <Link
            href={`/projects/${projectId}`}
            className="btn btn-ghost btn-sm shrink-0"
            aria-label={t('holdouts.startCampaignAria', { number: holdout.apartmentNumber })}
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('action.startCampaign')}</span>
          </Link>
        ))}
    </li>
  );
}

/**
 * The calm Hebrew failure-toast copy for a per-name holdout remind. The
 * "no live pending request" resolve-miss (`holdout_none_pending`) gets its own
 * honest line ("nothing to remind — the board may be stale"); the kill-switch
 * 503 reuses the paused copy; anything else falls back to the generic retry copy.
 * Pure (exported) for unit testing.
 */
export function buildHoldoutRemindErrorMessage(
  t: ReturnType<typeof useTranslations>,
  err: unknown,
): string {
  const code = holdoutRemindErrorCode(err);
  if (code === HOLDOUT_NONE_PENDING_CODE) return t('holdouts.remindNonePending');
  if (code === 'campaign_send_disabled') return t('action.remindDisabled');
  return t('action.remindFailed');
}

/** Best-effort `code` off a holdout-remind failure — any duck-typed
 *  `{ code: string }` (the `ApiClientError` the resolve/resend path throws). */
function holdoutRemindErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// ── HB-1 project-wide remind ────────────────────────────────────────────────

/**
 * HB-1 — the inline one-tap "remind the project's PENDING signers" action.
 *
 * PROJECT-scoped (the projectId is in scope on every card): on click it POSTs
 * `/projects/:id/signature-requests/remind` (no body) via `postIdempotent` (the
 * BE is idempotent — a double-tap re-delivers the same pending set once), then
 * shows a calm Hebrew result toast derived from `{ reminded, total }` and
 * refreshes the board (`invalidateQueries(['signature-pulse'])`).
 *
 * Gating (layered, never a dead button):
 *   - VISIBILITY: the parent only renders this when `signature_requests.send`
 *     is held (Viewer never sees it).
 *   - KILL-SWITCH pre-disable: when `sendEnabled === false` the button is
 *     disabled with calm explanatory copy and the request never fires — belt-
 *     and-suspenders with the BE 503 `campaign_send_disabled`.
 *   - IN-FLIGHT: disabled + pending label while the mutation runs (no double-tap).
 */
export function RemindButton({
  projectId,
  projectName,
  sendEnabled,
  t,
}: {
  projectId: string;
  projectName: string;
  sendEnabled: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const remind = useMutation({
    mutationFn: async (): Promise<RemindResult> => {
      const res = await apiClient.postIdempotent<RemindResult>(
        `/projects/${projectId}/signature-requests/remind`,
        {},
      );
      if (!isOk(res)) throw new RemindError(res.error.code);
      return res.data;
    },
    onSuccess: (data) => {
      toast.show({ message: buildRemindResultMessage(t, data) });
    },
    onError: (err) => {
      toast.show({ message: buildRemindErrorMessage(t, err), variant: 'assertive' });
    },
    onSettled: () => {
      // Refresh the board so the pulse (and any derived attention) reflects the
      // re-delivered reminders. The board reads exactly one pulse query key.
      void queryClient.invalidateQueries({ queryKey: ['signature-pulse'] });
    },
  });

  const disabled = !sendEnabled || remind.isPending;
  // Calm explanatory copy when the kill-switch is off — surfaced as a native
  // tooltip AND the accessible description so the disabled state is never silent.
  const switchOffCopy = t('action.remindDisabled');

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={disabled}
      aria-disabled={disabled}
      aria-busy={remind.isPending}
      aria-label={t('action.remindAria', { name: projectName })}
      title={!sendEnabled ? switchOffCopy : undefined}
      onClick={() => {
        // Belt: never fire while disabled (kill-switch off or in-flight).
        if (disabled) return;
        remind.mutate();
      }}
    >
      <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{remind.isPending ? t('action.remindPending') : t('action.remind')}</span>
    </button>
  );
}

/** The `{ reminded, total }` success payload from the remind endpoint. */
interface RemindResult {
  reminded: number;
  total: number;
}

/** A typed remind failure carrying the wire `error.code` so the toast can
 *  special-case the kill-switch 503 (`campaign_send_disabled`). */
class RemindError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RemindError';
  }
}

/**
 * The calm Hebrew result-toast copy for a remind, derived from `{ reminded,
 * total }`. `total === 0` → "no pending signatures in the project"; otherwise
 * "{reminded} reminders sent". Pure (exported) for unit testing.
 */
export function buildRemindResultMessage(
  t: ReturnType<typeof useTranslations>,
  result: RemindResult,
): string {
  if (result.total === 0) return t('action.remindNonePending');
  return t('action.remindSent', { count: result.reminded });
}

/**
 * The calm Hebrew failure-toast copy for a remind. The kill-switch 503
 * (`campaign_send_disabled`) gets its own calm "sending is paused" line; any
 * other failure falls back to the generic retry copy. Pure (exported) for tests.
 */
export function buildRemindErrorMessage(
  t: ReturnType<typeof useTranslations>,
  err: unknown,
): string {
  if (remindErrorCode(err) === 'campaign_send_disabled') {
    return t('action.remindDisabled');
  }
  return t('action.remindFailed');
}

/** Best-effort `code` off a remind failure — a `RemindError` (the mutation
 *  path) or any duck-typed `{ code: string }` (keeps the helper testable
 *  without exporting the error class). */
function remindErrorCode(err: unknown): string | undefined {
  if (err instanceof RemindError) return err.code;
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// ── Tier-0 / calm-state primitives + pure helpers ───────────────────────────

/** The calm reward marker shown in the all-clear empty-state. */
export function AllClearBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
      <CheckCircle2 className="h-4 w-4 text-brand" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Time-of-day greeting (Asia/Jerusalem-agnostic — keyed off the viewer's local
 *  hour, which is the natural "good morning" frame for a single-tz product). */
export function buildGreeting(t: ReturnType<typeof useTranslations>): string {
  const hour = new Date().getHours();
  if (hour < 12) return t('greeting.morning');
  if (hour < 18) return t('greeting.afternoon');
  return t('greeting.evening');
}

/** The ONE pulse sentence — assembled from the (calm, factual) bucket clauses.
 *  Each non-zero bucket contributes one plain clause; joined with " · ". When
 *  everything is on-track the sentence is the reassuring all-on-track line. */
export function buildPulseSentence(
  t: ReturnType<typeof useTranslations>,
  buckets: { stalled: number; expiringSoon: number; needsHuman: number; onTrack: number },
): string {
  const clauses: string[] = [];
  if (buckets.stalled > 0) clauses.push(t('clause.stalled', { count: buckets.stalled }));
  if (buckets.expiringSoon > 0) clauses.push(t('clause.expiring', { count: buckets.expiringSoon }));
  if (buckets.needsHuman > 0) clauses.push(t('clause.needsHuman', { count: buckets.needsHuman }));
  if (clauses.length === 0) {
    // Nothing needs a human — report the calm state (on-track count if any).
    return buckets.onTrack > 0
      ? t('clause.allOnTrack', { count: buckets.onTrack })
      : t('clause.nothingYet');
  }
  return clauses.join(' · ');
}

/** The short status TAG for a card's chip, selected by its reason. Literal
 *  `t()` keys (not a template) so the i18n-coverage guard can verify them. */
export function buildTag(
  t: ReturnType<typeof useTranslations>,
  card: PulseActionCardViewModel,
): string {
  switch (card.reason) {
    case 'stalled':
      return t('reason.stalled.tag');
    case 'expiring':
      return t('reason.expiring.tag');
    case 'notStarted':
      return t('reason.notStarted.tag');
    case 'consentGap':
    default:
      return t('reason.consentGap.tag');
  }
}

/** The plain-Hebrew "why" line for a card, selected by its top-priority
 *  reason. The system speaks like a competent assistant reporting what it saw. */
export function buildWhy(
  t: ReturnType<typeof useTranslations>,
  card: PulseActionCardViewModel,
): string {
  switch (card.reason) {
    case 'stalled':
      return t('reason.stalled.why', { days: card.stalledDays ?? 0 });
    case 'expiring':
      return t('reason.expiring.why');
    case 'notStarted':
      return t('reason.notStarted.why');
    case 'consentGap':
    default:
      return t('reason.consentGap.why');
  }
}
