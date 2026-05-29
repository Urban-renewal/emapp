/**
 * Form-boundary value coercions for react-hook-form `register(...)`.
 *
 * §FUNC-1 — the empty-string class bug. An untouched text `<input>`
 * registered with RHF submits an EMPTY STRING `''`, not `undefined`.
 * For an OPTIONAL field whose Zod schema carries a format/min constraint
 * — e.g. `z.string().email().optional()` or `z.string().min(9).optional()`
 * — `''` is rejected: `.optional()` permits only `undefined`, `.nullable()`
 * only `null`, and `.email()`/`.min()` reject the empty string. The result
 * is a form the user cannot submit while leaving that optional field blank
 * (the audit found this on the owner-create form's `email`).
 *
 * `emptyToUndefined` is the form-boundary fix: pass it as `setValueAs` so a
 * blank optional input becomes `undefined` (i.e. omitted) BEFORE the Zod
 * resolver runs. This keeps the wire contract intact — the `.strict()`
 * body simply omits the field rather than sending an empty string — and is
 * the root fix (not a schema loosening that would let `''` reach the BE).
 *
 * Scope note (manual sweep, 2026-05-29): across the `zodResolver` RHF forms
 * in apps/web, only `owners/new` (`email`, `phone`) had an optional field
 * with a constraint that rejects `''`. Required formatted fields (e.g.
 * contractor `contactEmail`) correctly reject blanks; other optional fields
 * are `.max()`-only and tolerate `''`. One field of the same class exists
 * outside the resolver path — `org_slug` (`min(1).optional()`) on the
 * tenant-login form — but that form deliberately uses no zodResolver and
 * already normalizes `'' → undefined` by hand. Apply this helper to any
 * future optional+formatted field on a resolver-backed form to keep the
 * class closed.
 */
export function emptyToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}
