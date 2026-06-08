import type { SharePermissions } from '../schema/_share-permissions';

/**
 * D.46 — the default permission set for a NEW contractor share.
 *
 * Least-privilege per the locked D.46 contractor profile:
 *  - overview (project / buildings / apartments structural) → ON
 *  - signatures (progress, AGGREGATE % only — see `signatureScopeForShare`) → ON
 *  - documents (manager-SELECTED) → OFF — the manager opts in + picks
 *
 * A3 (L4): owners/PII (`tenants`), `notes`, `team`, and document `upload`
 * were removed — they were DEAD keys the contractor read-path never
 * consulted (and `tenants.fields.national_id` was a PII footgun). The
 * contractor tier now grants exactly: overview / documents{download} /
 * signatures.
 */
export function defaultSharePermissions(): SharePermissions {
  return {
    overview: { on: true },
    documents: {
      // OFF by default (D.46 "manager-selected") — opt-in per share.
      on: false,
      actions: { download: true },
    },
    // Signature PROGRESS on by default — aggregate-only (no who/individual),
    // structurally guaranteed by `signatureScopeForShare`.
    signatures: { on: true },
  };
}
