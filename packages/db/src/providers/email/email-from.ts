import { env } from '../../env';

/**
 * The system-verified default From — the SINGLE source of truth for the
 * outbound sender ADDRESS. Resolved from `EMAIL_FROM` (Infisical/env) with a
 * baked fallback so dev/test always has a usable value.
 *
 * SECURITY/DELIVERABILITY (P6 — branding.email-from decision record):
 *   The From *address* is ALWAYS this verified system address. A per-org
 *   `branding.emailFrom` custom ADDRESS is NOT honored — an arbitrary
 *   from-address is a spoofing vector AND Resend/most MTAs reject a sender
 *   on an unverified domain. Only the From *display name* is per-org
 *   configurable (see `buildEmailFrom`). Custom from-addresses are DEFERRED
 *   until owner domain-verification exists.
 */
export const DEFAULT_EMAIL_FROM: string = env.EMAIL_FROM ?? 'EMAPP <no-reply@emapp.co.il>';

/**
 * Extract the bare email address from a From string that may be either a
 * plain address (`no-reply@x.co.il`) or a display-name form
 * (`EMAPP <no-reply@x.co.il>`). Returns the address inside the LAST
 * `<…>` if present, else the trimmed input. Used so we re-attach the
 * verified address regardless of how `systemFrom` was written.
 */
function extractAddress(systemFrom: string): string {
  const m = /<([^<>]+)>\s*$/.exec(systemFrom);
  return (m?.[1] ?? systemFrom).trim();
}

/**
 * Sanitize an org-configured `senderName` so it is SAFE to place inside an
 * RFC 5322 `From` display name. This is a header-injection guard — load-
 * bearing.
 *
 * Strips, in order:
 *   - CR / LF and ALL C0/C1 control chars (U+0000–U+001F, U+007F) — header
 *     injection (a `\r\n` could inject a `Bcc:` or split the header).
 *   - the RFC 5322 specials that would break/escape the display-name token
 *     or the address angle-brackets: `"`  `<`  `>`  `(`  `)`  `,`  `:`  `;`
 *     `\`  `@`  `[`  `]`. Removing (not escaping) keeps ONE simple, safe
 *     rule — a clean unquoted display name.
 * Then collapses internal whitespace, trims, and caps at 120 chars (the
 * `branding.senderName` schema bound). Returns '' if nothing safe remains.
 */
function sanitizeSenderName(senderName: string): string {
  let out = '';
  for (const ch of senderName) {
    const c = ch.codePointAt(0) ?? 0;
    // Drop C0 controls (incl. CR/LF/TAB), DEL, C1 controls, and the Unicode
    // line/paragraph separators U+2028/U+2029 (defense-in-depth: harmless on the
    // current JSON/HTTPS Resend transport, but transport-agnostic header safety).
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x2028 || c === 0x2029)
      continue;
    // Drop RFC 5322 specials / quote / angle-brackets / backslash / at-sign.
    if ('"<>(),:;\\@[]'.includes(ch)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Build the outbound `From` header value from a per-org display name and the
 * verified system From.
 *
 * - The From *address* is ALWAYS the verified address parsed out of
 *   `systemFrom` — `senderName` NEVER changes the address (display-name only).
 * - `senderName` is sanitized (see `sanitizeSenderName`). If it sanitizes to
 *   empty / blank (or is undefined), we fall back to `systemFrom` UNCHANGED.
 * - Otherwise returns `"<clean senderName> <address>"`.
 *
 * Pure (env-free): the caller passes `systemFrom` (typically
 * `DEFAULT_EMAIL_FROM`). ONE helper — every send site that wants the org
 * display name uses this; never hand-rolls a From string.
 */
export function buildEmailFrom(senderName: string | undefined, systemFrom: string): string {
  if (senderName === undefined) return systemFrom;
  const clean = sanitizeSenderName(senderName);
  if (clean.length === 0) return systemFrom;
  return `${clean} <${extractAddress(systemFrom)}>`;
}
