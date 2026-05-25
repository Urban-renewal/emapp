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
