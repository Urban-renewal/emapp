/**
 * P2 (Tier-0 #2) — SMS channel in signature-link delivery.
 *
 * Dedicated TEST-AUTHOR spec (separate from the engineer). Pure unit,
 * zero-infra: FAKE IEmailProvider + FAKE ISMSProvider injected as plain
 * objects implementing the interfaces. No network, no DB.
 *
 * Covers the newly-wired SMS path in `deliverSignatureLink` + the
 * `buildResidentInviteSms` template, adversarially:
 *  - template carries ownerName + documentName + signUrl, non-empty.
 *  - sent / queued / rejected / throws / no-phone status mapping.
 *  - PRIVACY: the rejected AND throw log lines must NOT leak the phone
 *    number or the signUrl (the URL embeds the signing token).
 *  - channel independence (email failure ⟂ sms result).
 *  - the sms ChannelResult must NOT echo the raw phone in `to`.
 */
import type {
  EmailMessage,
  EmailDeliveryResult,
  IEmailProvider,
  ISMSProvider,
  SMSDeliveryResult,
} from '@emapp/db';
import { describe, expect, it, vi } from 'vitest';

import {
  buildResidentInviteSms,
  deliverSignatureLink,
  type SignatureLinkContext,
} from './signature-link-delivery';

// ─── Test fixtures ─────────────────────────────────────────────────

const PHONE = '0541234567';
const SIGN_URL = 'https://app.emapp.co.il/sign/eyJhbGciOi.SECRET-TOKEN-PART.sig';
const OWNER = 'דנה כהן';
const DOC = 'הסכם תמ"א 38';

function ctx(over: Partial<SignatureLinkContext> = {}): SignatureLinkContext {
  return {
    signUrl: SIGN_URL,
    ownerName: OWNER,
    ownerEmail: null,
    ownerPhone: PHONE,
    documentName: DOC,
    ...over,
  };
}

/** Fake email provider whose send() returns a fixed result (or throws). */
function fakeEmail(result: EmailDeliveryResult | (() => Promise<EmailDeliveryResult>)): {
  provider: IEmailProvider;
  calls: EmailMessage[];
} {
  const calls: EmailMessage[] = [];
  const provider: IEmailProvider = {
    async send(message: EmailMessage): Promise<EmailDeliveryResult> {
      calls.push(message);
      if (typeof result === 'function') return result();
      return result;
    },
    async healthCheck(): Promise<void> {},
  };
  return { provider, calls };
}

/** Fake SMS provider — records (to, body) and returns/throws as configured. */
function fakeSms(behavior: SMSDeliveryResult | (() => Promise<SMSDeliveryResult>)): {
  provider: ISMSProvider;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async (_to: string, _body: string) => {
    if (typeof behavior === 'function') return behavior();
    return behavior;
  });
  const provider: ISMSProvider = {
    send: send as unknown as ISMSProvider['send'],
    async healthCheck(): Promise<void> {},
  };
  return { provider, send };
}

/** Logger spy capturing every logger.error(message) argument. */
function spyLogger(): { logger: { error: (m: string) => void }; errors: string[] } {
  const errors: string[] = [];
  return { logger: { error: (m: string) => errors.push(m) }, errors };
}

// A provider that always works — used when the channel under test is the
// "other" channel and we only care it doesn't interfere.
const OK_SMS: SMSDeliveryResult = { id: 'sms_1', status: 'sent' };
const OK_EMAIL: EmailDeliveryResult = { id: 'em_1', status: 'sent' };

// ─── buildResidentInviteSms ────────────────────────────────────────

describe('buildResidentInviteSms', () => {
  it('returns a non-empty Hebrew body containing ownerName, documentName, signUrl', () => {
    const body = buildResidentInviteSms({
      ownerName: OWNER,
      documentName: DOC,
      signUrl: SIGN_URL,
    });
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain(OWNER);
    expect(body).toContain(DOC);
    expect(body).toContain(SIGN_URL);
  });

  it('is link-forward: the signUrl appears verbatim (not truncated/encoded)', () => {
    const body = buildResidentInviteSms({
      ownerName: OWNER,
      documentName: DOC,
      signUrl: SIGN_URL,
    });
    expect(body.indexOf(SIGN_URL)).toBeGreaterThanOrEqual(0);
  });
});

// ─── deliverSignatureLink — SMS channel ────────────────────────────

describe('deliverSignatureLink — SMS channel', () => {
  it('ownerPhone present + sms.send {status:sent} → report.sms {available, sent}; called with (phone, body⊇signUrl)', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms, send } = fakeSms({ id: 's', status: 'sent' });
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(email, sms, ctx(), logger);

    expect(report.sms.available).toBe(true);
    expect(report.sms.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    const [toArg, bodyArg] = send.mock.calls[0] as [string, string];
    expect(toArg).toBe(PHONE);
    expect(bodyArg).toContain(SIGN_URL);
    expect(bodyArg).toContain(DOC);
  });

  it('ownerPhone present + sms.send {status:queued} → available true, status queued', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms({ id: 's', status: 'queued' });
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(email, sms, ctx(), logger);

    expect(report.sms.available).toBe(true);
    expect(report.sms.status).toBe('queued');
  });

  it('ownerPhone present + sms.send {status:rejected} (STRUCTURAL) → {available:false, reason:sms_rejected}', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms({ id: 's', status: 'rejected', error: 'gateway-said-no' });
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(email, sms, ctx(), logger);

    expect(report.sms.available).toBe(false);
    expect(report.sms.reason).toBe('sms_rejected');
    expect(report.sms.status).toBeUndefined();
  });

  it('ownerPhone present + sms.send {status:failed} (TRANSPORT-AMBIGUOUS, #509) → {available:false, reason:sms_send_failed}', async () => {
    // A provider `failed` is a transport-ambiguous outcome (5xx / timeout / network
    // throw flattened by the provider). It MUST map to the ambiguous bucket
    // (`sms_send_failed`), NOT `sms_rejected` — else the Governor would re-claim +
    // re-send a message that may already have gone out → double SMS.
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms({ id: 's', status: 'failed', error: 'http_504' });
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(email, sms, ctx(), logger);

    expect(report.sms.available).toBe(false);
    expect(report.sms.reason).toBe('sms_send_failed');
    expect(report.sms.status).toBeUndefined();
  });

  it('ownerPhone present + sms.send THROWS → {available:false, reason:sms_send_failed} and does NOT propagate', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms, send } = fakeSms(async () => {
      throw new Error('socket hang up');
    });
    const { logger } = spyLogger();

    // Must resolve, not reject.
    const report = await deliverSignatureLink(email, sms, ctx(), logger);

    expect(send).toHaveBeenCalledTimes(1);
    expect(report.sms.available).toBe(false);
    expect(report.sms.reason).toBe('sms_send_failed');
  });

  it('ownerPhone null → {available:false, reason:no_phone_on_file} and sms.send NOT called', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms, send } = fakeSms(OK_SMS);
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(email, sms, ctx({ ownerPhone: null }), logger);

    expect(report.sms.available).toBe(false);
    expect(report.sms.reason).toBe('no_phone_on_file');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not double-send: exactly one sms.send per successful delivery', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms, send } = fakeSms(OK_SMS);
    const { logger } = spyLogger();

    await deliverSignatureLink(email, sms, ctx(), logger);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ─── PRIVACY (adversarial) — no phone / no signUrl in logs ──────────

describe('deliverSignatureLink — SMS privacy in logs', () => {
  it('rejected path: logger.error does NOT contain the phone nor the signUrl/token', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms({ id: 's', status: 'rejected', error: 'blocked' });
    const { logger, errors } = spyLogger();

    await deliverSignatureLink(email, sms, ctx(), logger);

    expect(errors.length).toBeGreaterThan(0);
    const joined = errors.join('\n');
    expect(joined).not.toContain(PHONE);
    expect(joined).not.toContain(SIGN_URL);
    // the token segment of the URL must not leak either
    expect(joined).not.toContain('SECRET-TOKEN-PART');
  });

  it('throw path: logger.error does NOT contain the phone nor the signUrl/token', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms(async () => {
      throw new Error('boom');
    });
    const { logger, errors } = spyLogger();

    await deliverSignatureLink(email, sms, ctx(), logger);

    expect(errors.length).toBeGreaterThan(0);
    const joined = errors.join('\n');
    expect(joined).not.toContain(PHONE);
    expect(joined).not.toContain(SIGN_URL);
    expect(joined).not.toContain('SECRET-TOKEN-PART');
  });

  /**
   * Regression: a thrown SMS error whose MESSAGE embeds the phone/URL must NOT
   * leak into the log. The throw path logs only the error TYPE (constructor
   * name), never `e.message` — because a throwing HTTP client (axios/got/undici)
   * routinely echoes the request URL (token!) and body in its error text. This
   * was a real finding (test-author) and is now fixed.
   */
  it('a thrown error whose MESSAGE embeds the phone/URL does NOT leak into the log', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms(async () => {
      throw new Error(`request to ${SIGN_URL} for ${PHONE} failed`);
    });
    const { logger, errors } = spyLogger();

    await deliverSignatureLink(email, sms, ctx(), logger);

    const joined = errors.join('\n');
    expect(joined).not.toContain(PHONE);
    expect(joined).not.toContain(SIGN_URL);
    expect(joined).not.toContain('SECRET-TOKEN-PART');
    // The error TYPE is still logged for observability.
    expect(joined).toContain('Error');
  });
});

// ─── ChannelResult shape — no raw phone leak ───────────────────────

describe('deliverSignatureLink — SMS ChannelResult shape', () => {
  it('sms ChannelResult does NOT echo the raw phone in `to` (or anywhere)', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms(OK_SMS);
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(email, sms, ctx(), logger);

    expect(report.sms.to).toBeUndefined();
    // belt-and-suspenders: phone must not appear in any serialized field
    expect(JSON.stringify(report.sms)).not.toContain(PHONE);
    // and the signUrl/token must not be echoed back in the sms result
    expect(JSON.stringify(report.sms)).not.toContain('SECRET-TOKEN-PART');
  });
});

// ─── Channel independence ──────────────────────────────────────────

describe('deliverSignatureLink — channel independence', () => {
  it('failing email (throws) does not affect a working sms', async () => {
    const { provider: email } = fakeEmail(async () => {
      throw new Error('resend down');
    });
    const { provider: sms } = fakeSms(OK_SMS);
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(
      email,
      sms,
      ctx({ ownerEmail: 'owner@example.com' }),
      logger,
    );

    expect(report.email.available).toBe(false);
    expect(report.sms.available).toBe(true);
    expect(report.sms.status).toBe('sent');
  });

  it('failing sms (rejected) does not affect a working email', async () => {
    const { provider: email } = fakeEmail(OK_EMAIL);
    const { provider: sms } = fakeSms({ id: 's', status: 'rejected', error: 'x' });
    const { logger } = spyLogger();

    const report = await deliverSignatureLink(
      email,
      sms,
      ctx({ ownerEmail: 'owner@example.com' }),
      logger,
    );

    expect(report.email.available).toBe(true);
    expect(report.sms.available).toBe(false);
    expect(report.sms.reason).toBe('sms_rejected');
  });
});
