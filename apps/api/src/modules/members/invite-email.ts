import { FakeEmailProvider, type IEmailProvider } from '@emapp/db';

/**
 * D.27 closure — the member-invite token is delivered via IEmailProvider,
 * NOT returned in the API response in production.
 *
 * Provider selection follows the EXACT governed pattern accepted at Gate 4
 * for SMS (`{ provide: SMS_PROVIDER, useClass: NoopSMSProvider }` until the
 * real Israeli provider is an Infisical config swap): the abstraction is
 * wired now; the concrete Resend provider is dropped in at THIS single
 * factory once `RESEND_API_KEY` + the `resend` client land in Infisical
 * (Gate-4 SECRETS LAW — a credential/config swap, no code change elsewhere).
 */
export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

/** Token is exposed in the HTTP response ONLY outside production. In prod
 * the email channel is the sole delivery path (closes the D.27 risk). */
export const EXPOSE_INVITE_TOKEN = process.env['NODE_ENV'] !== 'production';

/**
 * HIGH-2 fix — production must NOT silently use FakeEmailProvider: with
 * the token suppressed in prod responses, Fake (in-memory, no mail) would
 * make every invite permanently unacceptable with no error. So in
 * production we FAIL FAST at boot unless a real provider is wired. This
 * is the hard pre-Gate-5 gate (recorded in GATES/PROGRESS), not a silent
 * governed no-op. Non-prod uses Fake (captures mail for dev/test).
 *
 * The Resend swap is the single point below: provision `resend` +
 * `RESEND_API_KEY` in Infisical (Gate-4 SECRETS LAW), then construct
 * `new ResendEmailProvider(new Resend(key), from)` here.
 */
export function emailProviderFactory(): IEmailProvider {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'EMAIL_PROVIDER: refusing to boot — production requires a real email ' +
        'provider (D.27). FakeEmailProvider would make invites undeliverable ' +
        'AND the token is suppressed in prod responses. Provision Resend ' +
        '(RESEND_API_KEY + client) and wire ResendEmailProvider in ' +
        'emailProviderFactory before deploying. See GATES Gate-5 / DECISIONS D.27.',
    );
  }
  return new FakeEmailProvider();
}

/** HIGH-1 fix — entity-escape any user-controlled value before it is
 * interpolated into the HTML body (name/orgName are Manager-supplied,
 * free-form up to 120 chars → stored HTML/phishing injection otherwise). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replace control chars (incl. CR/LF, U+0000–U+001F and U+007F) with a
 * space before a value reaches an email header (subject) — header-
 * injection defense for when a real provider is wired. Codepoint filter
 * (no control literals in source). */
function headerSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out.trim();
}

function inviteUrl(token: string): string {
  const base = (process.env['APP_BASE_URL'] ?? 'https://app.emapp.co.il').replace(/\/+$/, '');
  // Phase 4c S1 — path-style invite URL (token in the path, not a
  // query string). Defaults to Hebrew (`/he/`) since EMAPP is
  // Hebrew-first; the invitee can switch locale via the in-app
  // selector after accepting. Matches the FE route
  // `apps/web/src/app/[locale]/(auth)/accept-invite/[token]/page.tsx`
  // + the middleware whitelist regex (PUBLIC_ROUTE_REGEX). Encoding
  // is preserved because the JWT alphabet (`A-Za-z0-9_-` + `.`) is
  // URL-safe but `encodeURIComponent` is defense-in-depth for any
  // future signing-key change that widens the alphabet.
  return `${base}/he/accept-invite/${encodeURIComponent(token)}`;
}

export interface InviteEmailInput {
  to: string;
  name: string;
  orgName?: string;
  token: string;
}

/** Hebrew invite email. The token is a credential — never logged. All
 * user-controlled fields are escaped (html) / control-stripped (subject). */
export function buildInviteEmail(input: InviteEmailInput): {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags: Record<string, string>;
} {
  const url = inviteUrl(input.token);
  const safeNameHtml = escapeHtml(input.name);
  const safeOrgHtml = input.orgName ? ` ל${escapeHtml(input.orgName)}` : '';
  const orgSubject = input.orgName ? ` ל${headerSafe(input.orgName)}` : '';
  const subject = headerSafe(`הוזמנת להצטרף${orgSubject} ב-EMAPP`);
  const text =
    `שלום ${input.name},\n\n` +
    `הוזמנת להצטרף${input.orgName ? ` ל${input.orgName}` : ''} במערכת EMAPP.\n` +
    `להגדרת הסיסמה והשלמת ההצטרפות (הקישור בתוקף ל-7 ימים):\n${url}\n\n` +
    `אם לא ציפית להזמנה זו, ניתן להתעלם מהודעה זו.`;
  const html =
    `<div dir="rtl" style="font-family:Heebo,Arial,sans-serif">` +
    `<p>שלום ${safeNameHtml},</p>` +
    `<p>הוזמנת להצטרף${safeOrgHtml} במערכת <strong>EMAPP</strong>.</p>` +
    `<p><a href="${url}">הגדרת סיסמה והשלמת ההצטרפות</a> (בתוקף ל-7 ימים).</p>` +
    `<p style="color:#666;font-size:12px">אם לא ציפית להזמנה זו, ניתן להתעלם מהודעה זו.</p>` +
    `</div>`;
  return { to: input.to, subject, html, text, tags: { kind: 'org_invite' } };
}
