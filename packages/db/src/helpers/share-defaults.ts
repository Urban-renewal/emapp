import type { SharePermissions } from '../schema/_share-permissions';

/**
 * D.46 — the default permission set for a NEW contractor share.
 *
 * Least-privilege per the locked D.46 contractor profile:
 *  - overview (project / buildings / apartments structural) → ON
 *  - signatures (progress, AGGREGATE % only — see `signatureScopeForShare`) → ON
 *  - tenants (OWNERS / PII) → OFF — never, not even masked, by default
 *  - documents (manager-SELECTED) → OFF — the manager opts in + picks
 *  - notes / team → OFF
 *
 * The `tenants.fields` sub-flags stay all-off (name is the locked literal
 * `true` but is inert while `tenants.on` is false). The manager can widen
 * any of these per share; the DEFAULT denies owner PII.
 */
export function defaultSharePermissions(): SharePermissions {
  return {
    overview: { on: true },
    tenants: {
      // OFF by default (D.46) — a contractor never sees owners/PII unless
      // the manager deliberately turns this on.
      on: false,
      fields: {
        name: true,
        phone: false,
        email: false,
        national_id: false,
        note: false,
      },
    },
    documents: {
      // OFF by default (D.46 "manager-selected") — opt-in per share.
      on: false,
      actions: { download: true, upload: false },
    },
    // Signature PROGRESS on by default — aggregate-only (no who/individual),
    // structurally guaranteed by `signatureScopeForShare`.
    signatures: { on: true },
    notes: { on: false },
    team: { on: false },
  };
}
