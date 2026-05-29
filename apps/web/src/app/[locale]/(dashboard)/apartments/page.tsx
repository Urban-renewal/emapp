import { redirect } from 'next/navigation';

/**
 * §FUNC-3 — `/apartments` has no global list view. Apartments are scoped to a
 * building: they are listed at `/buildings/<id>/apartments` and opened
 * individually at `/apartments/<id>`. A bare visit to `/he/apartments`
 * previously hit Next's raw 404 — a dead end.
 *
 * Redirect to the projects hub (the top of the project → building → apartment
 * hierarchy) so the bare URL lands somewhere useful. `redirect('/projects')`
 * is locale-prefixed by the i18n middleware → `/he/projects`.
 */
export default function ApartmentsIndexPage() {
  redirect('/projects');
}
