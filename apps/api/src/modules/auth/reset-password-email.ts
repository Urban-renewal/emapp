/**
 * P1 R0.1 — password-reset email (OWASP Forgot-Password).
 *
 * Reuses the SAME governed delivery seam as the member invite (D.27): the
 * IEmailProvider abstraction wired via DI, Fake in dev/test, the Resend swap
 * a single Infisical config change. NO new email mechanism (SOLID/DRY).
 *
 * The reset link carries the RAW token in a query param (`/reset-password?
 * token=<raw>`): the token is a one-time, short-lived, opaque random value
 * (not PII, not a long-lived credential). It is NEVER logged (the api-client
 * pino redaction censors `req.body.token`/`req.params.token`; this token is a
 * query param the FE forwards in the POST body, where the redaction applies).
 */

/** Replace control chars (incl. CR/LF) before a value reaches an email header
 *  (subject) — header-injection defence for when a real provider is wired.
 *  Codepoint filter (no control literals in source). Mirrors invite-email.ts. */
function headerSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out.trim();
}

/** Build the absolute reset URL. Defaults to Hebrew (`/he/`) — EMAPP is
 *  Hebrew-first; the user can switch locale in-app. Matches the FE route
 *  `apps/web/src/app/[locale]/(auth)/reset-password/page.tsx` and the
 *  middleware PUBLIC_ROUTE_REGEX whitelist. `encodeURIComponent` is
 *  defence-in-depth (the hex token alphabet is already URL-safe). */
function resetUrl(rawToken: string): string {
  const base = (process.env['APP_BASE_URL'] ?? 'https://app.emapp.co.il').replace(/\/+$/, '');
  return `${base}/he/reset-password?token=${encodeURIComponent(rawToken)}`;
}

export interface ResetEmailInput {
  to: string;
  token: string;
}

/** Hebrew password-reset email. The token is a credential — never logged.
 *  No user-controlled free-form fields are interpolated (only the system URL),
 *  so there is no stored-HTML/phishing-injection surface here. */
export function buildResetEmail(input: ResetEmailInput): {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags: Record<string, string>;
} {
  const url = resetUrl(input.token);
  const subject = headerSafe('איפוס סיסמה ל-EMAPP');
  const text =
    `שלום,\n\n` +
    `קיבלנו בקשה לאיפוס הסיסמה לחשבונך ב-EMAPP.\n` +
    `לקביעת סיסמה חדשה (הקישור בתוקף ל-30 דקות):\n${url}\n\n` +
    `אם לא ביקשת לאפס את הסיסמה, ניתן להתעלם מהודעה זו — לא בוצע כל שינוי בחשבונך.`;
  const html =
    `<div dir="rtl" style="font-family:Heebo,Arial,sans-serif">` +
    `<p>שלום,</p>` +
    `<p>קיבלנו בקשה לאיפוס הסיסמה לחשבונך ב-<strong>EMAPP</strong>.</p>` +
    `<p><a href="${url}">לקביעת סיסמה חדשה</a> (בתוקף ל-30 דקות).</p>` +
    `<p style="color:#666;font-size:12px">אם לא ביקשת לאפס את הסיסמה, ניתן להתעלם מהודעה זו — לא בוצע כל שינוי בחשבונך.</p>` +
    `</div>`;
  return { to: input.to, subject, html, text, tags: { kind: 'password_reset' } };
}
