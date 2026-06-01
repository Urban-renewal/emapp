/**
 * Provider Admin "access reason" store — D.37 mandatory `access_reason`
 * header. The reason is operator-supplied free text that gets attached
 * to every `/api/v1/provider/*` call AND written to `provider_audit_log`.
 *
 * Lifecycle:
 *  - Set ONCE per session via the AccessReasonGate (the page-blocker that
 *    appears the first time the operator hits a `/provider/*` route).
 *  - Persists in sessionStorage for the rest of the tab session — closing
 *    the tab / logging out clears it.
 *  - We DO NOT persist in localStorage: a leftover reason across browser
 *    restarts could attach stale context to a fresh investigation, and
 *    SOX audit trails should reflect the operator's CURRENT intent.
 *
 * Threat-model linkage:
 *  - Security: the reason is the SOX/audit-trail anchor for cross-tenant
 *    access. An empty reason MUST refuse — both at the BE (400
 *    `reason_required`) and the FE (`ProviderReasonRequiredError`).
 *  - Performance: pure sessionStorage; zero runtime cost.
 *  - Error handling: read returns `null` when missing — pages render
 *    the gate; never throw.
 */
const STORAGE_KEY = 'emapp.provider.access_reason';

// ───────────────────────────────────────────────────────────────────
// D2-DEF-2 — FE-side mirror of the BE `validateProviderReason`
// (packages/db/src/helpers/provider-validators.ts). The gate previously
// accepted ≥8 chars while `withProvider` requires a ticket reference OR
// ≥20 substantive chars — so an 8–19-char non-ticket reason passed the
// gate but the first cross-tenant call failed with a generic error. This
// mirrors the EXACT BE rule so the gate rejects up-front.
//
// `@emapp/db` is the source of truth but is a backend package (pg/drizzle)
// that must NOT be imported into the browser bundle; this is a faithful
// copy pinned by `provider-reason.spec.ts` to the same contract.
// ───────────────────────────────────────────────────────────────────

/** Mirrors PROVIDER_TICKET_REF_REGEX. Bounded alternation + bounded
 *  `\d{2,}` — no catastrophic backtracking (audited with the BE copy). */
// eslint-disable-next-line security/detect-unsafe-regex -- mirror of the audited BE PROVIDER_TICKET_REF_REGEX
const TICKET_REF_REGEX = /^(INC|REQ|SUP|TKT|BUG|JIRA|GH|PR)-(?:[A-Z]+-)?\d{2,}/i;
// eslint-disable-next-line no-control-regex -- mirror of PROVIDER_CONTROL_CHARS_REGEX
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/g;
/** Mirrors SUBSTANTIVE_MIN_LEN / _TOKENS / _DISTINCT_CHARS. */
export const PROVIDER_REASON_SUBSTANTIVE_MIN_LEN = 20;
const SUBSTANTIVE_MIN_TOKENS = 3;
const SUBSTANTIVE_MIN_DISTINCT_CHARS = 4;
/** Mirrors PROVIDER_REASON_MAX_LEN — the BE rejects > 512 chars
 *  (`reason_too_long`); the gate must reject it too or a long reason
 *  passes here and fails the first cross-tenant call. */
export const PROVIDER_REASON_MAX_LEN = 512;

export type ProviderReasonResult =
  | { ok: true; value: string }
  | { ok: false; code: 'low_quality' | 'too_long' };

/**
 * Validate an operator reason against the SAME rule the BE enforces
 * (`validateProviderReason`). Accepts a recognised ticket reference (e.g.
 * `INC-1234`) OR substantive free text (≥20 chars, ≥3 tokens, ≥4 distinct
 * chars); rejects anything over the 512-char cap. Pure.
 */
export function validateProviderReasonClient(raw: string): ProviderReasonResult {
  const cleaned = raw.replace(CONTROL_CHARS_REGEX, '').trim();
  // Max-length cap applies regardless of ticket/substantive shape (BE
  // checks length BEFORE the ticket fast-path).
  if (cleaned.length > PROVIDER_REASON_MAX_LEN) return { ok: false, code: 'too_long' };
  if (TICKET_REF_REGEX.test(cleaned)) return { ok: true, value: cleaned };
  if (cleaned.length < PROVIDER_REASON_SUBSTANTIVE_MIN_LEN)
    return { ok: false, code: 'low_quality' };
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < SUBSTANTIVE_MIN_TOKENS) return { ok: false, code: 'low_quality' };
  if (new Set(cleaned.toLowerCase()).size < SUBSTANTIVE_MIN_DISTINCT_CHARS) {
    return { ok: false, code: 'low_quality' };
  }
  return { ok: true, value: cleaned };
}

/** Defensive read — returns null on SSR, empty value, or whitespace. */
export function readProviderReason(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Storage can throw (private mode in older browsers, quota, etc.).
    // Treat unreadable storage as "no reason" → the gate re-prompts.
    return null;
  }
}

/** Save the reason. Throws if value is blank — operators MUST type
 *  something substantive (the BE 400 catches this too but loud-fail
 *  at the gate is the better UX). */
export function setProviderReason(reason: string): void {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new Error('provider reason must be non-empty');
  }
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // Quota / private mode — silently no-op. The gate will re-prompt
    // on next page load; pages still work for the current render.
  }
}

/** Clear on logout / org switch. */
export function clearProviderReason(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Exposed for tests + the access-reason gate component. */
export const PROVIDER_REASON_STORAGE_KEY = STORAGE_KEY;
