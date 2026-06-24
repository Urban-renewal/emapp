/**
 * Phase 5 — signature-link delivery (S6).
 *
 * Three channels per docs/03 §9 + user-approved MVP scope:
 *  - Email   (Resend → IEmailProvider)  ← automated, free 3K/month tier
 *  - SMS     (ISMSProvider, Inforu)      ← automated; the primary channel for
 *                                          phone-only owners (most of them)
 *  - WhatsApp deep-link (wa.me URL)      ← Manager-driven, no API cost
 *
 * Design: the BE returns an honest per-channel report. Email AND SMS are sent
 * server-to-server through their injected providers. WhatsApp is a
 * `wa.me/<phone>?text=...` deep-link returned to the Manager FE, which opens
 * the Manager's own WhatsApp app when tapped. The SMS provider is Noop in dev
 * (logs, no send) and the real Israeli gateway in prod once creds are in
 * Infisical (the factory fails the prod boot if they're missing).
 *
 * SECURITY: token never appears in logs (pino redact catches /sign/...
 * URLs). Hebrew text is generated server-side; no user-controlled HTML
 * makes it into the email body un-escaped.
 */
import { type IEmailProvider, type ISMSProvider } from '@emapp/db';

/** HTML entity escape — same shape as the D.27 invite-email helper.
 *  All user-controlled fields go through this before they touch HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip control chars from values that land in email headers (subject).
 *  Prevents header injection / CRLF smuggling. */
export function headerSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? ' ' : ch;
  }
  return out.trim();
}

/** Convert an Israeli phone (encrypted-then-decrypted, stored as the
 *  user typed it — `0541234567` or `+972541234567`) to E.164 digits
 *  only for the `wa.me/<digits>` URL. wa.me requires no leading `+`. */
export function toWaPhone(phone: string): string | null {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 9) return null;
  // 0XXXXXXXXX → 972XXXXXXXXX
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  // already E.164 without +
  if (digits.startsWith('972')) return digits;
  // foreign / unknown — be conservative, don't build a link
  return null;
}

/** Mask an email for the response surface: `name@domain` → `na***@domain`.
 *  The Manager already knows the address; we just don't echo the raw
 *  value into wire artifacts that may be screenshotted. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  if (local.length <= 2) return `${local[0] ?? ''}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

// ─── Templates (Hebrew) ────────────────────────────────────────────

export interface SignatureEmailInput {
  to: string;
  ownerName: string;
  documentName: string;
  signUrl: string;
}

/** Manager-side notification after a resident signs (T5.7 — docs/03 §9
 *  DoD bullet "Email notification ליזם כשבעל דירה חותם"). NO IP/UA in
 *  the email body — IP/UA stays in the audit_log only (docs/07 §12.3
 *  sensitive, Provider-Admin only). */
export function buildManagerSignedNotification(input: {
  to: string;
  ownerName: string;
  documentName: string;
  signedAt: Date;
}): {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags: Record<string, string>;
} {
  const docNameSafe = escapeHtml(input.documentName);
  const ownerNameSafe = escapeHtml(input.ownerName);
  // Format the timestamp in Israel timezone (Asia/Jerusalem) per
  // CLAUDE.md "Dates: store UTC, display Asia/Jerusalem".
  const whenIL = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(input.signedAt);
  const whenSafe = escapeHtml(whenIL);
  const subject = headerSafe(`חתימה התקבלה — ${input.documentName}`);
  const text =
    `${input.ownerName} חתם על המסמך "${input.documentName}".\n` +
    `מועד: ${whenIL}\n\n` +
    `פרטי החתימה זמינים ב-EMAPP במסך החתימות.`;
  const html =
    `<div dir="rtl" style="font-family:Heebo,Arial,sans-serif">` +
    `<p><strong>${ownerNameSafe}</strong> חתם על המסמך <strong>${docNameSafe}</strong>.</p>` +
    `<p>מועד: ${whenSafe}</p>` +
    `<p style="color:#666;font-size:12px">פרטי החתימה זמינים ב-EMAPP במסך החתימות.</p>` +
    `</div>`;
  return { to: input.to, subject, html, text, tags: { kind: 'signature_signed_mgr' } };
}

/** Resident-side confirmation after they sign (docs/03 §9 DoD bullet
 *  "Email confirmation לבעל דירה אחרי שחתם"). Best-effort — if the
 *  owner has no email on file, we skip silently. */
export function buildResidentSignedConfirmation(input: {
  to: string;
  ownerName: string;
  documentName: string;
}): {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags: Record<string, string>;
} {
  const docNameSafe = escapeHtml(input.documentName);
  const ownerNameSafe = escapeHtml(input.ownerName);
  const subject = headerSafe(`תודה — חתימתך נקלטה`);
  const text =
    `שלום ${input.ownerName},\n\n` +
    `החתימה שלך על "${input.documentName}" נקלטה בהצלחה.\n` +
    `אם לא חתמת על מסמך זה, צור קשר עם היזם בהקדם.`;
  const html =
    `<div dir="rtl" style="font-family:Heebo,Arial,sans-serif">` +
    `<p>שלום ${ownerNameSafe},</p>` +
    `<p>החתימה שלך על <strong>${docNameSafe}</strong> נקלטה בהצלחה.</p>` +
    `<p style="color:#666;font-size:12px">אם לא חתמת על מסמך זה, צור קשר עם היזם בהקדם.</p>` +
    `</div>`;
  return { to: input.to, subject, html, text, tags: { kind: 'signature_signed_resident' } };
}

/** Resident invite — "click here to sign". The link is a 7-day single-
 *  use JWT; no PII beyond names in the body. */
export function buildResidentInviteEmail(input: SignatureEmailInput): {
  to: string;
  subject: string;
  html: string;
  text: string;
  tags: Record<string, string>;
} {
  const docNameSafe = escapeHtml(input.documentName);
  const ownerNameSafe = escapeHtml(input.ownerName);
  const subject = headerSafe(`בקשת חתימה — ${input.documentName}`);
  const text =
    `שלום ${input.ownerName},\n\n` +
    `התבקשת לחתום על המסמך: ${input.documentName}\n` +
    `לחץ על הקישור הבא כדי לחתום (בתוקף ל-7 ימים):\n${input.signUrl}\n\n` +
    `אם אינך הנמען, ניתן להתעלם מהודעה זו.`;
  const html =
    `<div dir="rtl" style="font-family:Heebo,Arial,sans-serif">` +
    `<p>שלום ${ownerNameSafe},</p>` +
    `<p>התבקשת לחתום על המסמך: <strong>${docNameSafe}</strong></p>` +
    `<p><a href="${input.signUrl}">לחץ כאן כדי לחתום</a> (הקישור בתוקף ל-7 ימים).</p>` +
    `<p style="color:#666;font-size:12px">אם אינך הנמען, ניתן להתעלם מהודעה זו.</p>` +
    `</div>`;
  return { to: input.to, subject, html, text, tags: { kind: 'signature_invite' } };
}

/** Resident invite SMS — short Hebrew body, link-forward (SMS segment limits).
 *  No PII beyond the owner's name; the signing link is a 7-day single-use JWT. */
export function buildResidentInviteSms(input: {
  ownerName: string;
  documentName: string;
  signUrl: string;
}): string {
  return (
    `שלום ${input.ownerName}, התבקשת לחתום על ${input.documentName}: ` +
    `${input.signUrl} (בתוקף ל-7 ימים)`
  );
}

/** WhatsApp deep-link — the Manager taps it on their phone to open
 *  their own WhatsApp with the message pre-filled to the resident.
 *  Returns null if phone shape is unusable. */
export function buildWhatsappDeepLink(input: {
  ownerPhoneE164OrLocal: string;
  ownerName: string;
  documentName: string;
  signUrl: string;
}): string | null {
  const phone = toWaPhone(input.ownerPhoneE164OrLocal);
  if (!phone) return null;
  const message =
    `שלום ${input.ownerName}, ` +
    `התבקשת לחתום על ${input.documentName}: ${input.signUrl} ` +
    `— הקישור בתוקף ל-7 ימים.`;
  // wa.me URL — `text=` is URL-encoded.
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

// ─── Delivery context + result ─────────────────────────────────────

export interface SignatureLinkContext {
  signUrl: string;
  ownerName: string;
  ownerEmail: string | null;
  /** Decrypted phone — as the manager typed it. Convert to wa.me digits
   *  via `toWaPhone()`. NEVER logged. */
  ownerPhone: string | null;
  documentName: string;
}

export interface ChannelResult {
  available: boolean;
  status?: 'sent' | 'queued' | 'ready' | 'rejected';
  to?: string;
  deepLink?: string;
  reason?: string;
}

export interface SignatureLinkReport {
  email: ChannelResult;
  whatsapp: ChannelResult;
  sms: ChannelResult;
}

/** Deliver via the three channels. Email + SMS do actual I/O (server-to-server
 *  send). WhatsApp returns a deep-link the FE renders as a button. SMS goes
 *  through the injected `ISMSProvider`: the real Israeli gateway in prod (when
 *  creds are configured), Noop in dev — so this is auto-delivery for the
 *  (common) phone-only owner who has no email on file. */
export async function deliverSignatureLink(
  email: IEmailProvider,
  sms: ISMSProvider,
  ctx: SignatureLinkContext,
  logger: { error: (m: string) => void },
  /** P6 — the resolved From for this org: the verified system address with the
   *  org's `branding.senderName` as the display name. Built ONLY via
   *  `buildEmailFrom` at the call site (single source — this file never
   *  hand-rolls a From). When omitted, the provider default From is used. */
  from?: string,
  /** M2 (consent/opt-out) — per-channel SUPPRESSION. The AUTONOMOUS reminder
   *  path resolves the recipient's outbound opt-outs and passes a suppressed
   *  channel here so it is NEVER sent, even when an address is on file. A
   *  suppressed channel reports `{ available:false, reason:'opted_out' }` (NOT a
   *  delivery). The MANUAL manager-resend path passes nothing (a deliberate
   *  manager action is not consent-gated). WhatsApp is a deep-link the FE
   *  renders, not an autonomous send, so it is not suppressed here. */
  suppress?: { email?: boolean; sms?: boolean },
): Promise<SignatureLinkReport> {
  const emailRes: ChannelResult = suppress?.email
    ? { available: false, reason: 'opted_out' }
    : ctx.ownerEmail
      ? await sendInviteEmail(email, ctx, logger, from)
      : { available: false, reason: 'no_email_on_file' };

  const waLink = ctx.ownerPhone
    ? buildWhatsappDeepLink({
        ownerPhoneE164OrLocal: ctx.ownerPhone,
        ownerName: ctx.ownerName,
        documentName: ctx.documentName,
        signUrl: ctx.signUrl,
      })
    : null;
  const whatsappRes: ChannelResult = waLink
    ? { available: true, status: 'ready', deepLink: waLink }
    : { available: false, reason: 'no_phone_on_file_or_unparseable' };

  const smsRes: ChannelResult = suppress?.sms
    ? { available: false, reason: 'opted_out' }
    : ctx.ownerPhone
      ? await sendInviteSms(sms, ctx, logger)
      : { available: false, reason: 'no_phone_on_file' };

  return { email: emailRes, whatsapp: whatsappRes, sms: smsRes };
}

/** Fire after a successful sign — notifies the manager (T5.7) and the
 *  resident (confirmation). Each send is independent; one failing does
 *  not abort the other, and neither one can block the response (we
 *  catch + log). Return shape mirrors the per-channel delivery report
 *  so the caller can include it in an audit row if desired. */
export interface PostSignNotifyContext {
  managerEmail: string | null;
  residentEmail: string | null;
  ownerName: string;
  documentName: string;
  signedAt: Date;
}

export async function notifyAfterSign(
  email: IEmailProvider,
  ctx: PostSignNotifyContext,
  logger: { error: (m: string) => void },
  /** P6 — resolved From (per-org `branding.senderName` display name via
   *  `buildEmailFrom`). Omitted → provider default From. */
  from?: string,
): Promise<{ manager: ChannelResult; resident: ChannelResult }> {
  const manager: ChannelResult = ctx.managerEmail
    ? await sendOne(
        email,
        buildManagerSignedNotification({
          to: ctx.managerEmail,
          ownerName: ctx.ownerName,
          documentName: ctx.documentName,
          signedAt: ctx.signedAt,
        }),
        'manager_notify',
        logger,
        from,
      )
    : { available: false, reason: 'no_manager_email_on_file' };

  const resident: ChannelResult = ctx.residentEmail
    ? await sendOne(
        email,
        buildResidentSignedConfirmation({
          to: ctx.residentEmail,
          ownerName: ctx.ownerName,
          documentName: ctx.documentName,
        }),
        'resident_confirm',
        logger,
        from,
      )
    : { available: false, reason: 'no_email_on_file' };

  return { manager, resident };
}

async function sendOne(
  email: IEmailProvider,
  msg: {
    to: string;
    subject: string;
    html: string;
    text: string;
    tags: Record<string, string>;
  },
  tag: string,
  logger: { error: (m: string) => void },
  from?: string,
): Promise<ChannelResult> {
  try {
    // The From display name (when configured) is attached here, NOT inside the
    // pure body-builders — they stay From-free. `from` is always pre-built by
    // `buildEmailFrom` at the call site (single source for header safety).
    const res = await email.send(from === undefined ? msg : { ...msg, from });
    if (res.status === 'failed') {
      // TRANSPORT-AMBIGUOUS (#509): may have dispatched → ambiguous bucket
      // (`*_send_failed`), same as the throw path. NEVER `*_rejected` (definite).
      logger.error(
        `[signature-delivery:${tag}] email send_failed for ${maskEmail(msg.to)}: ${res.error ?? 'unknown'}`,
      );
      return { available: false, reason: `${tag}_send_failed`, to: maskEmail(msg.to) };
    }
    if (res.status === 'rejected') {
      logger.error(
        `[signature-delivery:${tag}] email rejected for ${maskEmail(msg.to)}: ${res.error ?? 'unknown'}`,
      );
      return { available: false, reason: `${tag}_rejected`, to: maskEmail(msg.to) };
    }
    return { available: true, status: res.status, to: maskEmail(msg.to) };
  } catch (e: unknown) {
    // Log the error TYPE only — a throwing email client can echo the request
    // body (which embeds the signing token) in e.message. (Same hardening as
    // the SMS throw path.)
    logger.error(
      `[signature-delivery:${tag}] email send threw for ${maskEmail(msg.to)}: ${
        e instanceof Error ? e.constructor.name : 'unknown'
      }`,
    );
    return { available: false, reason: `${tag}_send_failed` };
  }
}

async function sendInviteEmail(
  email: IEmailProvider,
  ctx: SignatureLinkContext,
  logger: { error: (m: string) => void },
  from?: string,
): Promise<ChannelResult> {
  if (!ctx.ownerEmail) return { available: false, reason: 'no_email_on_file' };
  try {
    const msg = buildResidentInviteEmail({
      to: ctx.ownerEmail,
      ownerName: ctx.ownerName,
      documentName: ctx.documentName,
      signUrl: ctx.signUrl,
    });
    // Attach the per-org From display name here (the body-builder stays
    // From-free). `from` is always pre-built via `buildEmailFrom`.
    const res = await email.send(from === undefined ? msg : { ...msg, from });
    if (res.status === 'failed') {
      // TRANSPORT-AMBIGUOUS (#509): the provider could not confirm the send (5xx /
      // timeout) — it MAY have gone out. Map to the ambiguous bucket
      // (`email_send_failed`), same as the throw path; NEVER `email_rejected`
      // (definite). The classifier parks it; the Governor never auto-resends it.
      logger.error(
        `[signature-delivery] email send_failed for ${maskEmail(ctx.ownerEmail)}: ` +
          `${res.error ?? 'unknown'}`,
      );
      return { available: false, reason: 'email_send_failed' };
    }
    if (res.status === 'rejected') {
      // Provider gave a STRUCTURAL rejection (invalid/suppressed address) —
      // provably did not send → definite. Surface as generic unavailable; never
      // echo the provider's internal code (could be a deliverability tell).
      logger.error(
        `[signature-delivery] email rejected for ${maskEmail(ctx.ownerEmail)}: ` +
          `${res.error ?? 'unknown'}`,
      );
      return { available: false, reason: 'email_rejected' };
    }
    return {
      available: true,
      status: res.status, // 'sent' | 'queued'
      to: maskEmail(ctx.ownerEmail),
    };
  } catch (e: unknown) {
    // Provider blew up — do NOT fail the manager's create call. Log
    // the failure with the masked address only and report unavailable.
    logger.error(
      `[signature-delivery] email send threw for ${maskEmail(ctx.ownerEmail)}: ` +
        `${e instanceof Error ? e.constructor.name : 'unknown'}`,
    );
    return { available: false, reason: 'email_send_failed' };
  }
}

async function sendInviteSms(
  sms: ISMSProvider,
  ctx: SignatureLinkContext,
  logger: { error: (m: string) => void },
): Promise<ChannelResult> {
  if (!ctx.ownerPhone) return { available: false, reason: 'no_phone_on_file' };
  try {
    const body = buildResidentInviteSms({
      ownerName: ctx.ownerName,
      documentName: ctx.documentName,
      signUrl: ctx.signUrl,
    });
    const res = await sms.send(ctx.ownerPhone, body);
    if (res.status === 'failed') {
      // TRANSPORT-AMBIGUOUS (#509): the provider could not confirm the send went
      // out (network throw / 5xx / timeout / unparseable body). The SMS MAY have
      // already been dispatched, so this maps to the SAME ambiguous bucket as a
      // thrown send (`*_send_failed`) — `classifyNonDelivery` treats it AMBIGUOUS
      // and the Governor parks it (never auto-resent). NEVER map this to
      // `sms_rejected` (definite) — that would risk a double-send.
      logger.error(`[signature-delivery:sms] send_failed: ${res.error ?? 'unknown'}`);
      return { available: false, reason: 'sms_send_failed' };
    }
    if (res.status === 'rejected') {
      // STRUCTURAL decline (gateway received the call and refused the message —
      // invalid number / bad creds). A true non-send → DEFINITE → re-claimable.
      // Never log the phone or the signing URL (the URL embeds the token).
      logger.error(`[signature-delivery:sms] rejected: ${res.error ?? 'unknown'}`);
      return { available: false, reason: 'sms_rejected' };
    }
    return { available: true, status: res.status };
  } catch (e: unknown) {
    // Do NOT interpolate e.message — a throwing SMS client may echo the request
    // URL (which embeds the signing token) or the recipient phone into its error
    // text. Log only the error TYPE (matches the email path's masking discipline
    // + the file's "token never appears in logs" guarantee).
    logger.error(
      `[signature-delivery:sms] send threw: ${e instanceof Error ? e.constructor.name : 'unknown'}`,
    );
    return { available: false, reason: 'sms_send_failed' };
  }
}
