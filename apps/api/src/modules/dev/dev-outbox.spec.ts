/**
 * Dev email outbox inspector — fail-closed gate + capture + link extraction.
 *
 * The outbox is a DEV-ONLY, token-bearing surface, so the load-bearing test is
 * that it is INVISIBLE (404, not 403) whenever `isDevAuthBypass()` is false —
 * i.e. always in production. Plus: the dev email factory hands every sender ONE
 * shared FakeEmailProvider (so the outbox captures all mail), and the link
 * extractor pulls the signing/invite link cleanly out of the email body.
 */
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../common/dev-auth-bypass', () => ({ isDevAuthBypass: vi.fn() }));

import { isDevAuthBypass } from '../../common/dev-auth-bypass';
import { emailProviderFactory, getDevEmailOutbox } from '../members/invite-email';

import { DevOutboxController, extractLinks } from './dev-outbox.controller';

const mockBypass = vi.mocked(isDevAuthBypass);

describe('extractLinks', () => {
  it('extracts http(s) URLs and de-dupes, preserving order', () => {
    expect(extractLinks('a http://x.co/1 b https://y.co/2 again http://x.co/1')).toEqual([
      'http://x.co/1',
      'https://y.co/2',
    ]);
  });
  it('stops at the closing quote/angle so an href yields a clean URL', () => {
    expect(extractLinks('<a href="https://app.emapp.co.il/sign/JWT.ABC-_">חתום</a>')).toEqual([
      'https://app.emapp.co.il/sign/JWT.ABC-_',
    ]);
  });
  it('returns [] when there is no URL', () => {
    expect(extractLinks('no links here')).toEqual([]);
  });
});

describe('DevOutboxController — fail-closed (404 when not dev-bypass)', () => {
  const ctrl = new DevOutboxController();
  beforeEach(() => {
    mockBypass.mockReset();
    getDevEmailOutbox()?.reset();
  });

  it('list() throws 404 (invisible) when isDevAuthBypass() is false — the prod posture', () => {
    mockBypass.mockReturnValue(false);
    expect(() => ctrl.list()).toThrow(NotFoundException);
  });

  it('clear() throws 404 when isDevAuthBypass() is false', () => {
    mockBypass.mockReturnValue(false);
    expect(() => ctrl.clear()).toThrow(NotFoundException);
  });

  it('list() surfaces captured emails + the extracted link when dev-bypass is on', async () => {
    mockBypass.mockReturnValue(true);
    // Send through the REAL factory — proving the controller reads the SAME
    // shared instance every sender writes to.
    const provider = emailProviderFactory();
    await provider.send({
      to: 'owner@example.com',
      subject: 'בקשת חתימה',
      text: 'לחתום: https://app.emapp.co.il/sign/JWT.ABC (בתוקף ל-7 ימים)',
      tags: { kind: 'signature_invite' },
    });
    const res = ctrl.list();
    expect(res.data.count).toBe(1);
    const email = res.data.emails[0]!;
    expect(email.to).toBe('owner@example.com');
    expect(email.tags?.kind).toBe('signature_invite');
    expect(email.links).toContain('https://app.emapp.co.il/sign/JWT.ABC');
  });

  it('clear() empties the outbox when dev-bypass is on', async () => {
    mockBypass.mockReturnValue(true);
    await emailProviderFactory().send({ to: 'a@b.co', subject: 's', text: 'x' });
    expect(ctrl.list().data.count).toBe(1);
    ctrl.clear();
    expect(ctrl.list().data.count).toBe(0);
  });
});

describe('emailProviderFactory — ONE shared dev outbox across all senders', () => {
  it('returns the SAME FakeEmailProvider instance on every call (non-prod)', () => {
    const a = emailProviderFactory();
    const b = emailProviderFactory();
    expect(a).toBe(b);
    expect(getDevEmailOutbox()).toBe(a);
  });
});
