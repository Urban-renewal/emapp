'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BellRing, CheckCircle2, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useToast } from '@/components/ui/action-toast';
import { DataState } from '@/components/ui/data-state';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useSessionProfile } from '@/hooks/use-session';
import { useSignaturePulse } from '@/hooks/use-signature-pulse';
import { apiClient, isOk } from '@/lib/api-client';
import type { PulseActionCardViewModel } from '@/models/signature-pulse.vm';

/**
 * MissionControlHome — the board-first "signature mission-control" home
 * (E2 Wave-2 E2.1; the centerpiece of the E2 redesign).
 *
 * North-Star doctrine made concrete: the system did the work; the manager just
 * approves. The home is NOT a stats dump — it is calm exception-triage at scale:
 *
 *   1. A time-of-day greeting (the human "hello", with the manager's name).
 *   2. ONE plain-Hebrew PULSE SENTENCE summarising the org from `buckets`
 *      ("3 פרויקטים תקועים · 2 חתימות פגות השבוע") — words, not metric-soup.
 *   3. Up to 5 ranked ActionCards — the projects that NEED you now. The wire
 *      `attention[]` is already ranked most-urgent-first by the server's
 *      `rankAttention`; we render that order. Each card states the WHY in plain
 *      Hebrew + the consent % WITH its mandatory basis label, and offers the
 *      primary action (open the project — read-only, always safe).
 *   4. An explain-chip ("למה אני רואה את זה?") that honestly states the
 *      deterministic ranking — power revealed progressively, never a black box.
 *   5. A calm REWARD empty-state ("הכול תחת שליטה") when nothing needs a human —
 *      reuses the C2 DataState guided-empty shape, never a blank or an alarm.
 *
 * Both ManagerHome and AgentHome render this island: the B1 endpoint is
 * scope-aware on the BE (manager/viewer → whole org; agent → assigned only), so
 * there is no role branch here. Viewer read-only is honoured by gating any
 * MUTATING affordance on its permission; the "open project" link is a pure
 * read-navigation that every role may follow (B11).
 *
 * Token-only styling: EMAPP semantic classes (`text-foreground`, `text-muted`,
 * `.card`, `.badge`, `.btn`) — no inline color literal, no default palette, so
 * a re-skin flows through. RTL-first via logical props. All copy via next-intl.
 */
export function MissionControlHome() {
  const t = useTranslations('home.pulse');
  const tConsent = useTranslations('consent');
  const pulse = useSignaturePulse();
  const profile = useSessionProfile();

  // Viewer read-only (B11): the "remind" track mutates → gate on the send
  // permission. "Open project" is read-navigation and is always offered.
  const canRemind = useHasPermission('signature_requests.send');

  const [explainOpen, setExplainOpen] = useState(false);
  // Stable static id (NOT useId): exactly one MissionControlHome renders per
  // page (page.tsx role-branches Manager/Agent home — never both), so a fixed
  // id is collision-free AND deterministic across SSR↔client. useId() here
  // produced a tree-position prefix that differed server vs client under the
  // App-Router RSC boundary → a hydration-mismatch console error on the
  // centerpiece. A constant eliminates it with zero behavioural change.
  const explainId = 'mission-control-home';

  const vm = pulse.data;
  const greeting = buildGreeting(t);
  const managerName = profile.data?.name ?? '';

  return (
    <div className="flex flex-col gap-6">
      {/* 1) Greeting — the calm human "hello". */}
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-foreground">
          {managerName ? (
            <>
              {greeting}
              {', '}
              <NameDisplay name={managerName} bare />
            </>
          ) : (
            greeting
          )}
        </h1>
        {/* 2) The ONE pulse sentence — rendered once the feed resolves. */}
        {vm ? (
          <p className="text-sm text-text" role="status">
            {buildPulseSentence(t, vm.buckets)}
          </p>
        ) : (
          <p className="text-sm text-text-muted">{t('subtitleLoading')}</p>
        )}
      </header>

      {/* 3) The ranked ActionCards (or the calm states via DataState). */}
      <section aria-labelledby={`${explainId}-attn`} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id={`${explainId}-attn`} className="text-sm font-semibold text-foreground">
            {t('attentionHeading')}
          </h2>
          {/* 4) Explain-chip — honest, deterministic "why am I seeing this?". */}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-foreground"
            aria-expanded={explainOpen}
            aria-controls={`${explainId}-explain`}
            onClick={() => setExplainOpen((o) => !o)}
          >
            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('explain.trigger')}
          </button>
        </div>

        {explainOpen && (
          <p
            id={`${explainId}-explain`}
            className="card card-pad text-xs text-text-muted"
            role="note"
          >
            {t('explain.body')}
          </p>
        )}

        <DataState
          isLoading={pulse.isLoading}
          isError={pulse.isError}
          error={pulse.error}
          isEmpty={Boolean(vm?.isAllClear)}
          onRetry={() => void pulse.refetch()}
          skeleton="list"
          emptyTitle={
            vm && vm.totalInScope === 0 ? t('empty.noProjectsTitle') : t('allClear.title')
          }
          emptyHint={vm && vm.totalInScope === 0 ? t('empty.noProjectsHint') : t('allClear.hint')}
          emptyAction={
            vm && vm.totalInScope === 0 ? undefined : <AllClearBadge label={t('allClear.badge')} />
          }
        >
          {vm && (
            <ul className="flex flex-col gap-3">
              {vm.cards.map((card) => (
                <li key={card.projectId}>
                  <ActionCard
                    card={card}
                    canRemind={canRemind}
                    sendEnabled={vm.sendEnabled}
                    t={t}
                    basisLabel={tConsent('basisShare')}
                  />
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </section>
    </div>
  );
}

/** A single ranked attention card. Presentational — every derivation already
 *  happened in the adapter; this only lays out the WHY + the action. */
function ActionCard({
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
    <article className="card card-pad flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
        {/* Mutating "remind" track — only for actors who may send (Viewer hidden). */}
        {canRemind && (
          <RemindButton
            projectId={card.projectId}
            projectName={card.projectName}
            sendEnabled={sendEnabled}
            t={t}
          />
        )}
      </div>
    </article>
  );
}

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
function RemindButton({
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
      // re-delivered reminders. The home reads exactly one pulse query key.
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

/** The calm reward marker shown in the all-clear empty-state. */
function AllClearBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
      <CheckCircle2 className="h-4 w-4 text-brand" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Time-of-day greeting (Asia/Jerusalem-agnostic — keyed off the viewer's local
 *  hour, which is the natural "good morning" frame for a single-tz product). */
function buildGreeting(t: ReturnType<typeof useTranslations>): string {
  const hour = new Date().getHours();
  if (hour < 12) return t('greeting.morning');
  if (hour < 18) return t('greeting.afternoon');
  return t('greeting.evening');
}

/** The ONE pulse sentence — assembled from the (calm, factual) bucket clauses.
 *  Each non-zero bucket contributes one plain clause; joined with " · ". When
 *  everything is on-track the sentence is the reassuring all-on-track line. */
function buildPulseSentence(
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
function buildTag(t: ReturnType<typeof useTranslations>, card: PulseActionCardViewModel): string {
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
function buildWhy(t: ReturnType<typeof useTranslations>, card: PulseActionCardViewModel): string {
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
