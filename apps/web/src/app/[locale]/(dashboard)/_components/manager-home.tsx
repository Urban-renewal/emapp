import { HomeActions } from './home-actions';
import { MissionControlHome } from './mission-control-home';

/**
 * ManagerHome — the manager/viewer landing surface (E2 Wave-2 E2.1).
 *
 * REPLACED the V11 KPI-grid + calendar-stub dashboard with the board-first
 * "signature mission-control" home (North-Star centerpiece: the system does the
 * work, the manager just approves). The former `GET /org/stats` SSR fetch + the
 * 4-card KPI grid + the calendar/conversations two-column stub are GONE — the
 * home is no longer a stats dump; it surfaces the ~5 projects that need a human
 * now plus one calm pulse sentence.
 *
 * Thin Server Component wrapper: it mounts the `MissionControlHome` client
 * island (which owns the data fetch via the `useSignaturePulse` TanStack hook,
 * matching the codebase's established `(dashboard)/*` client-island pattern —
 * apps/web/CLAUDE.md §v9-M-1) and keeps the permission-gated "פרויקט חדש" CTA
 * (`HomeActions`, gated on `projects.create` — a viewer never sees it).
 *
 * `GET /org/stats` is no longer consumed by the home; it remains used by other
 * surfaces (it is NOT retired here).
 */
export function ManagerHome() {
  return (
    <div className="flex flex-col gap-6">
      <MissionControlHome />
      <HomeActions />
    </div>
  );
}
