import { redirect } from 'next/navigation';

/**
 * §FUNC-3 — `/buildings` has no global list view. Buildings are scoped to a
 * project: they are listed at `/projects/<id>/buildings` and opened
 * individually at `/buildings/<id>`. A bare visit to `/he/buildings`
 * (mistyped, bookmarked, or from a stripped link) previously hit Next's raw
 * 404 — a dead end with no way back into the app.
 *
 * Redirect to the projects hub (the parent surface from which every building
 * is reached) so the bare URL lands somewhere useful. `redirect('/projects')`
 * is locale-prefixed by the i18n middleware → `/he/projects` (same pattern as
 * the settings page's `redirect('/login')`).
 */
export default function BuildingsIndexPage() {
  redirect('/projects');
}
