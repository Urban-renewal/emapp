import type { docScopeEnum, ExternalShare, ExternalShareScopeType } from '@emapp/db';

/** The canonical document scope taxonomy (0077 DH1): org | project | apartment
 *  | owner. Derived from the DB enum so it can never drift from the schema. */
export type DocScope = (typeof docScopeEnum.enumValues)[number];

/**
 * SEC-H1 — the ONE shared external-party authorization resolver.
 *
 * The audit (DOCUMENT-SECURITY-AUDIT blocker #8) found that
 * `external_shares.expires_at / otp_required / allow_sensitive / watermark`
 * are persisted + ceiling-validated at MINT but have NO read-consumer — they
 * LOOK enforced but aren't. This module is that read-consumer: ONE generic,
 * fail-closed decision function (not per-endpoint copies) that, given a live
 * external-share grant + a candidate document + a request context, decides
 * allow/deny and (on allow) the serve constraints.
 *
 * Design corrections honored:
 *  - GENERIC: a single `decide()` — every party-read surface calls THIS, never
 *    a hand-rolled copy.
 *  - FAIL-CLOSED: every gate is an explicit deny; the function returns `allow`
 *    only after EVERY gate passes. A new field defaults to "does not widen".
 *  - NO PII IN ERRORS: deny reasons are a closed enum of coarse codes — never a
 *    doc name, national_id, owner, or scope id.
 *  - STRUCTURAL sensitive exclusion: a non-`allow_sensitive` share can NEVER
 *    yield a sensitive doc (the deny is unconditional, not "after OTP"); a
 *    sensitive doc additionally requires OTP to have been verified this session.
 *  - SET-BASED scope membership is resolved by the caller (DB query, RLS) and
 *    handed in as a boolean — this pure core never touches the DB, so it is
 *    exhaustively unit-testable.
 *
 * SCOPE BOUNDARY (deliberate): this slice enforces the PARTY share path
 * (`external_shares`). The live CONTRACTOR portal stays on its own `shares` +
 * JWT path (#499 added its retrieval-time expiry); its cutover onto this
 * resolver is a separate, later step (H-generic (b)/(c)/(d)).
 */

/** Coarse, PII-free deny codes. NEVER carry a doc name / id / owner / scope. */
export type ExternalPartyDenyReason =
  | 'share_revoked'
  | 'share_expired'
  | 'documents_not_granted'
  | 'download_not_granted'
  | 'out_of_scope'
  | 'sensitive_not_allowed'
  | 'otp_required'
  | 'document_not_servable';

/** The serve-time constraints a granted decision carries to the serve layer. */
export interface ExternalPartyServeConstraints {
  /**
   * The doc must be served via the API decrypt-stream (never a bearer/presigned
   * URL) — true for any `bytes_encrypted` (sensitive) doc. Mirrors the org-side
   * `resolveDownload` rule: sensitive bytes never leave the app as a URL.
   */
  requiresDecryptStream: boolean;
  /** Watermark-overlay subject the serve layer stamps onto served bytes (X-S5).
   *  Free text, never PII-keyed; null when the grant carries no watermark. */
  watermarkSubject: string | null;
}

export type ExternalPartyDecision =
  | { allow: true; constraints: ExternalPartyServeConstraints }
  | { allow: false; reason: ExternalPartyDenyReason };

/** The minimal document facts the decision needs. The caller selects these
 *  under `withTenant` RLS (so org-isolation is already enforced) — this core
 *  decides policy, RLS decides tenancy. */
export interface ResolvableDocument {
  /** Server-derived PII flag (`documents.sensitive`). */
  sensitive: boolean;
  /** App-envelope-encrypted at rest (`documents.bytes_encrypted`). */
  bytesEncrypted: boolean;
  /**
   * Is the doc a member of the share's scope? Resolved SET-BASED by the caller
   * (project/building/apartment membership query under RLS). The pure core
   * treats a non-member as out-of-scope, fail-closed.
   */
  inScope: boolean;
  /**
   * Is the doc servable at all (finalized + scan-clean + not archived)? Resolved
   * by the caller's select predicate; a non-servable doc denies generically.
   */
  servable: boolean;
}

/** Request context independent of the grant + doc. */
export interface ExternalPartyRequestContext {
  /** Evaluation instant (injectable for tests). */
  now: Date;
  /**
   * Has the party completed the OTP step-up for THIS session? The OTP delivery
   * channel itself is X-S4; this resolver only consumes the verified/no-verified
   * signal so the gate is structural here and ready when X-S4 lands. Defaults to
   * a fail-closed `false` if the caller cannot prove a verification.
   */
  otpVerified: boolean;
}

/** The grant facts the decision needs — the live `external_share` row (re-read
 *  under RLS by the caller, so revocation/expiry are never stale). */
export type ResolvableShare = Pick<
  ExternalShare,
  'permissions' | 'allowSensitive' | 'otpRequired' | 'expiresAt' | 'revokedAt' | 'watermarkSubject'
>;

/**
 * The pure decision. Order is fail-closed and security-ordered: lifecycle
 * (revocation, expiry) first, then permission, then scope, then the sensitive
 * gate (structural exclusion BEFORE the OTP gate so a non-allow_sensitive share
 * NEVER even reaches the OTP question for a sensitive doc), then servability.
 *
 * EXPIRY is enforced on EVERY call (not just at mint): `expiresAt <= now` →
 * deny, exactly like the contractor guard re-asserts `exp` at retrieval.
 */
export function decideExternalPartyAccess(
  share: ResolvableShare,
  doc: ResolvableDocument,
  ctx: ExternalPartyRequestContext,
): ExternalPartyDecision {
  // (1) Lifecycle — revoked is immediate kill.
  if (share.revokedAt) return { allow: false, reason: 'share_revoked' };

  // (2) Expiry — enforced at RETRIEVAL on every request. A null expiresAt is a
  //     non-expiring grant (the ceiling/TTL cap is applied at mint, not here).
  if (share.expiresAt && share.expiresAt.getTime() <= ctx.now.getTime()) {
    return { allow: false, reason: 'share_expired' };
  }

  // (3) Permission — the documents resource + the download capability must both
  //     be granted to serve a document's bytes.
  if (!share.permissions.documents.on) {
    return { allow: false, reason: 'documents_not_granted' };
  }
  if (!share.permissions.documents.actions.download) {
    return { allow: false, reason: 'download_not_granted' };
  }

  // (4) Scope membership — set-based, resolved by the caller under RLS.
  if (!doc.inScope) return { allow: false, reason: 'out_of_scope' };

  // (5) Sensitive gate — STRUCTURAL exclusion first: a non-allow_sensitive share
  //     can NEVER yield a sensitive doc, regardless of OTP. THEN, for a share
  //     that DOES allow sensitive, a sensitive doc still requires a verified OTP
  //     step-up this session (and, defense-in-depth, if the grant marks
  //     otp_required, OTP must be verified for it too).
  if (doc.sensitive) {
    if (!share.allowSensitive) return { allow: false, reason: 'sensitive_not_allowed' };
    if (!ctx.otpVerified) return { allow: false, reason: 'otp_required' };
  } else if (share.otpRequired && !ctx.otpVerified) {
    // A share that mandates OTP gates EVERY doc behind it, sensitive or not.
    return { allow: false, reason: 'otp_required' };
  }

  // (6) Servability — finalized + scan-clean + not archived (caller's predicate).
  if (!doc.servable) return { allow: false, reason: 'document_not_servable' };

  // ALLOW — carry the serve constraints. Sensitive (encrypted) bytes MUST go via
  // the decrypt-stream, never a presigned URL (mirrors org-side resolveDownload).
  return {
    allow: true,
    constraints: {
      requiresDecryptStream: doc.bytesEncrypted,
      watermarkSubject: share.watermarkSubject ?? null,
    },
  };
}

/**
 * The doc's resolved scope locator. The DB caller resolves these under RLS and
 * hands them to the pure predicate.
 *
 * `docScope` is the CANONICAL scope concept (0077 DH1): a doc is genuinely
 * project-level ONLY when `docScope = 'project'`. The legacy `projectId` column
 * is NON-NULL for an APARTMENT- or OWNER-scoped doc too (the apartment lives in
 * the project), so `projectId` ALONE is NOT a project-scope signal — that was
 * the leak (#11): a project-scope grant matched per-owner / per-apartment docs
 * because their `project_id` chained up to the granted project.
 */
export interface DocScopeLocator {
  /** Canonical scope taxonomy of the doc (0077). The authoritative axis. */
  docScope: DocScope;
  projectId: string | null;
  buildingId: string | null;
  apartmentId: string | null;
  /**
   * Per-owner attribution (0077 `documents.owner_id`). A doc ABOUT a specific
   * owner (e.g. their נסח / ID extract) is owner-scoped data even if filed with
   * a NULL apartment_id and a legacy `docScope='org'`. Forward-defense for #11:
   * a project-scope grant must NEVER reach an owner-attributed doc, so the
   * predicate excludes any `ownerId !== null` from a project scope — closing the
   * future case where canonical owner-attribution is wired without an apartment
   * binding. Null today for every live doc (the writer sets neither field). */
  ownerId: string | null;
}

/**
 * Pure scope-membership predicate. SCOPE-LEVEL DISJOINT + fail-closed:
 *
 *  - A `project`-scope grant matches ONLY a genuinely PROJECT-LEVEL doc — i.e.
 *    one that is NOT bound to an apartment AND is NOT owner/apartment-scoped.
 *    A per-owner agreement or per-apartment doc whose `project_id` chains up to
 *    the granted project is EXCLUDED (#11): project-scope ≠ apartment-scope.
 *  - A `building`-scope grant matches a doc whose apartment's building is in
 *    scope (apartment/owner docs flow up through the building).
 *  - An `apartment`-scope grant matches a doc bound to that apartment.
 *
 * Kept pure so the membership matrix is unit-testable independent of the DB.
 */
export function isDocInShareScope(
  scopeType: ExternalShareScopeType,
  scopeIds: readonly string[],
  docLocator: DocScopeLocator,
): boolean {
  const ids = new Set(scopeIds);
  if (scopeType === 'project') {
    // A project-scope grant reaches ONLY project-level docs. Exclude anything
    // bound to an apartment, attributed to an owner, OR scoped to an apartment/
    // owner (the canonical axis), even when its legacy project_id chains up to
    // the granted project.
    if (docLocator.apartmentId !== null) return false;
    if (docLocator.ownerId !== null) return false;
    if (docLocator.docScope === 'apartment' || docLocator.docScope === 'owner') return false;
    return docLocator.projectId !== null && ids.has(docLocator.projectId);
  }
  if (scopeType === 'building') {
    return docLocator.buildingId !== null && ids.has(docLocator.buildingId);
  }
  // apartment
  return docLocator.apartmentId !== null && ids.has(docLocator.apartmentId);
}
