/**
 * D.27 unit proof — invite-email helpers (deterministic, zero-infra).
 * Pins: token-in-response suppressed in prod; token delivered only via the
 * /accept-invite link; factory FAILS FAST in production (HIGH-2); all
 * user-controlled fields are HTML-escaped / control-stripped (HIGH-1);
 * the token never lands in tags/subject.
 */
import { FakeEmailProvider } from '@emapp/db';
import { afterEach, describe, expect, it } from 'vitest';

import { EXPOSE_INVITE_TOKEN, buildInviteEmail, emailProviderFactory } from './invite-email';

describe('D.27 · invite-email', () => {
  const prevEnv = process.env['NODE_ENV'];
  const prevBase = process.env['APP_BASE_URL'];
  afterEach(() => {
    if (prevEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prevEnv;
    if (prevBase === undefined) delete process.env['APP_BASE_URL'];
    else process.env['APP_BASE_URL'] = prevBase;
  });

  it('EXPOSE_INVITE_TOKEN is true only outside production (vitest env)', () => {
    expect(EXPOSE_INVITE_TOKEN).toBe(process.env['NODE_ENV'] !== 'production');
    expect(EXPOSE_INVITE_TOKEN).toBe(true);
  });

  it('factory returns Fake outside prod; FAILS FAST in production (HIGH-2)', async () => {
    const p = emailProviderFactory();
    expect(p).toBeInstanceOf(FakeEmailProvider);
    expect((await p.send({ to: 'a@b.co', subject: 's', text: 't' })).status).toBe('sent');

    process.env['NODE_ENV'] = 'production';
    expect(() => emailProviderFactory()).toThrowError(/refusing to boot/i);
  });

  it('email embeds the token in an /accept-invite link, Hebrew subject', () => {
    const token = 'TOK.EN.value-123';
    const m = buildInviteEmail({ to: 'dana@example.com', name: 'דנה', token, orgName: 'אלפא' });
    expect(m.to).toBe('dana@example.com');
    expect(m.subject).toContain('הוזמנת');
    expect(m.subject).toContain('אלפא');
    expect(m.html).toContain(`/accept-invite?token=${encodeURIComponent(token)}`);
    expect(m.text).toContain(`/accept-invite?token=${encodeURIComponent(token)}`);
    expect(JSON.stringify(m.tags)).not.toContain(token); // token never in metadata
    expect(m.subject).not.toContain(token);
    expect(m.tags['kind']).toBe('org_invite');
  });

  it('HIGH-1: name/orgName are HTML-escaped in the html body (no injection)', () => {
    const m = buildInviteEmail({
      to: 'x@y.z',
      name: '</p><img src=x onerror=alert(1)><p>',
      orgName: '<script>steal()</script>',
      token: 'abc',
    });
    expect(m.html).not.toContain('<img src=x');
    expect(m.html).not.toContain('<script>steal()');
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
  });

  it('HIGH-1: control chars (CRLF) stripped from the subject (header-injection)', () => {
    const m = buildInviteEmail({
      to: 'x@y.z',
      name: 'X',
      orgName: 'Acme\r\nBcc: attacker@evil.test',
      token: 'abc',
    });
    // CR/LF removed → cannot break out of the subject header into Bcc/etc.
    expect(m.subject).not.toContain('\r');
    expect(m.subject).not.toContain('\n');
    expect(m.subject.split('\n')).toHaveLength(1);
  });

  it('invite URL honours APP_BASE_URL and strips trailing slashes', () => {
    process.env['APP_BASE_URL'] = 'https://app.example.co.il///';
    const m = buildInviteEmail({ to: 'x@y.z', name: 'X', token: 'abc' });
    expect(m.html).toContain('https://app.example.co.il/accept-invite?token=abc');
  });
});
