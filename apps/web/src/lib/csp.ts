/**
 * Single source of truth for the FE Content-Security-Policy.
 *
 * §MQA-1 (2026-06-04) — MOVED here from `next.config.ts` `headers()` because the
 * production `script-src` needs a PER-REQUEST nonce. Next.js App Router emits
 * INLINE bootstrap + RSC-flight scripts (`self.__next_f.push(...)`); a static
 * `script-src 'self'` (no nonce, no `'unsafe-inline'`) BLOCKS them, so the whole
 * production app rendered BLANK — hydration threw `Error: Connection closed.`
 * because `self.__next_f` stayed `[]`. A config-level header cannot mint a
 * per-request nonce, so the CSP is now built per request in `middleware.ts`,
 * which sets it on BOTH the request headers (Next extracts the nonce + applies
 * it to its inline scripts) and the response headers (the browser enforces it).
 * See docs/DV-FINDINGS-DISPOSITION.md MQA-1.
 *
 * SECURITY INVARIANTS (enforced by `middleware.spec.ts` M10 / M10b):
 *  - PROD `script-src` = `'self' 'nonce-<v>' 'strict-dynamic'` — NEVER `unsafe-*`.
 *  - DEV `script-src` keeps `'unsafe-inline' 'unsafe-eval'` (Next Fast Refresh
 *    inline bootstrap + react-refresh `eval`). Dev is local-machine / CI only —
 *    these keywords are NEVER on deployed traffic.
 *  - `connect-src` MUST include the R2 host (browser PUT to the presigned upload
 *    URL) and stay in LOCK-STEP with the API helmet `connectSrc`
 *    (apps/api/src/main.ts). Divergence silently breaks every upload.
 */

/** §csp-r2 — keep in lock-step with `apps/api/src/main.ts` helmet `connectSrc`. */
export const CSP_CONNECT_SRC = "connect-src 'self' https://*.r2.cloudflarestorage.com";

/**
 * The `script-src` directive.
 *  - PROD: nonce + `strict-dynamic`, no `unsafe-*`. `'self'` is only a CSP2
 *    fallback for browsers that ignore `strict-dynamic`; CSP3 browsers trust
 *    ONLY the nonce'd bootstrap script + the chunks it dynamically loads.
 *  - DEV: unchanged from the original working dev posture (`'unsafe-inline'`
 *    for Next's dev inline bootstrap, `'unsafe-eval'` for react-refresh HMR).
 */
export function buildScriptSrc(nonce: string, isDev: boolean): string {
  return isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
}

/** Build the full CSP header value for one request. */
export function buildCspHeader(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    buildScriptSrc(nonce, isDev),
    // `style-src 'unsafe-inline'` — Tailwind + Heebo emit inline style
    // attributes; the risk surface is bounded (style attrs cannot execute
    // code). Unchanged accepted posture (Doc 07 §6.13).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // §PERF-M3 — `next/font/google` self-hosts; no gstatic allowance needed.
    "font-src 'self' data:",
    CSP_CONNECT_SRC,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
