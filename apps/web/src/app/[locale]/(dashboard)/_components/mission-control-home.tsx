'use client';

import { HelpCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { DataState } from '@/components/ui/data-state';
import { NameDisplay } from '@/components/ui/name-display';
import { useHasPermission } from '@/hooks/use-permissions';
import { useSessionProfile } from '@/hooks/use-session';
import { useSignaturePulse } from '@/hooks/use-signature-pulse';

import {
  ActionCard,
  AllClearBadge,
  buildGreeting,
  buildPulseSentence,
  FleetSection,
} from './situation-picture';

// Re-export the shared board primitives + pure helpers from the situation-picture
// module so existing importers (and the mission-control-home spec) resolve the
// SAME symbols after the Slice-1 extract — ONE source of truth, no duplication.
export {
  buildHoldoutRemindErrorMessage,
  buildRemindErrorMessage,
  buildRemindResultMessage,
  HoldoutApartment,
  HoldoutRow,
} from './situation-picture/board-primitives';

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
 * The presentational primitives (ActionCard / FleetSection / holdout drill-down
 * / remind) now live in the shared `situation-picture/` module so the signatures
 * surface reuses the EXACT same pieces — ONE source of truth (Slice-1 extract).
 *
 * Token-only styling: EMAPP semantic classes (`text-foreground`, `text-text-muted`,
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

          {/* 5) HB-4 — the calm queue-tail line. The board shows only the top-N
              ranked attention cards; this reassures the manager that the rest of
              the portfolio is still tracked (not forgotten) WITHOUT cluttering the
              triage list. N = (total tracked in scope) − (cards shown). Rendered
              only when N > 0 (never "ועוד 0"); suppressed entirely in the empty/
              all-clear state (DataState owns those, so `vm.cards.length === 0`
              short-circuits here). */}
          {vm && vm.cards.length > 0 && vm.totalInScope - vm.cards.length > 0 && (
            <p className="text-xs text-text-muted" role="status">
              {t('queueTail', { count: vm.totalInScope - vm.cards.length })}
            </p>
          )}
        </DataState>
      </section>

      {/* 6) NS-Fleet — the COMPLETE situation picture. The attention cards above
          are the EXCEPTIONS (the ~5 that need you now); this calm grid shows the
          WHOLE fleet — every in-scope project as a compact tile (state chip +
          consent sliver + zoom-in link). The board evolves from an attention-only
          feed into the full fleet at a glance: the REST is VISIBLE, not hidden.
          Rendered only once the feed resolves with ≥1 project (the all-clear /
          no-projects states are owned by the attention section's DataState). */}
      {vm && vm.fleet.length > 0 && (
        <FleetSection
          fleet={vm.fleet}
          fleetCapped={vm.fleetCapped}
          totalInScope={vm.totalInScope}
        />
      )}
    </div>
  );
}
