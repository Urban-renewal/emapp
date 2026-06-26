/**
 * Adversarial unit tests for the SMS provider factory (D.20). Pure unit:
 * manipulates `process.env` and restores the original after each test. NO
 * network, NO DB. Authored by a separate test-author (separation of concerns).
 *
 * The guarantee under test: production — OR an UNSET/typo'd NODE_ENV (red-team #14,
 * a deployed image that forgot `ENV NODE_ENV=production`) — must FAIL FAST if real
 * creds are absent (NoopSMSProvider would make Tenant OTP + signature SMS silently
 * undeliverable). ONLY an explicit development/test env falls back to Noop, and ALL
 * THREE creds are required.
 */
import { InforuSmsProvider, NoopSMSProvider } from '@emapp/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { smsProviderFactory } from './sms-provider.factory';

const KEYS = [
  'SMS_PROVIDER_USER',
  'SMS_PROVIDER_TOKEN',
  'SMS_PROVIDER_SENDER',
  'SMS_PROVIDER_API_URL',
  'NODE_ENV',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('smsProviderFactory — real creds present', () => {
  it('USER + TOKEN + SENDER present → InforuSmsProvider (any env)', () => {
    process.env['SMS_PROVIDER_USER'] = 'u';
    process.env['SMS_PROVIDER_TOKEN'] = 't';
    process.env['SMS_PROVIDER_SENDER'] = 's';
    process.env['NODE_ENV'] = 'development';
    expect(smsProviderFactory()).toBeInstanceOf(InforuSmsProvider);
  });

  it('full creds in production → InforuSmsProvider (does NOT throw)', () => {
    process.env['SMS_PROVIDER_USER'] = 'u';
    process.env['SMS_PROVIDER_TOKEN'] = 't';
    process.env['SMS_PROVIDER_SENDER'] = 's';
    process.env['NODE_ENV'] = 'production';
    expect(smsProviderFactory()).toBeInstanceOf(InforuSmsProvider);
  });
});

describe('smsProviderFactory — production fail-fast on missing/partial creds', () => {
  it('production + no creds → throws, message mentions D.20 / refusing to boot', () => {
    process.env['NODE_ENV'] = 'production';
    expect(() => smsProviderFactory()).toThrow(/D\.20/);
    expect(() => smsProviderFactory()).toThrow(/refusing to boot/i);
  });

  it('production + USER only (partial) → throws (requires ALL three)', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SMS_PROVIDER_USER'] = 'u';
    expect(() => smsProviderFactory()).toThrow();
  });

  it('production + USER+TOKEN but no SENDER (partial) → throws', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SMS_PROVIDER_USER'] = 'u';
    process.env['SMS_PROVIDER_TOKEN'] = 't';
    expect(() => smsProviderFactory()).toThrow();
  });

  it('production + empty-string creds → throws (empty strings are falsy)', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SMS_PROVIDER_USER'] = '';
    process.env['SMS_PROVIDER_TOKEN'] = '';
    process.env['SMS_PROVIDER_SENDER'] = '';
    expect(() => smsProviderFactory()).toThrow(/D\.20/);
  });
});

describe('smsProviderFactory — explicit dev/test fall back to Noop', () => {
  it('development + no creds → NoopSMSProvider', () => {
    process.env['NODE_ENV'] = 'development';
    expect(smsProviderFactory()).toBeInstanceOf(NoopSMSProvider);
  });

  it('test env + partial creds → NoopSMSProvider (no throw in test)', () => {
    process.env['NODE_ENV'] = 'test';
    process.env['SMS_PROVIDER_USER'] = 'u';
    expect(smsProviderFactory()).toBeInstanceOf(NoopSMSProvider);
  });
});

describe('smsProviderFactory — FAIL-CLOSED on unset/typo NODE_ENV (red-team #14)', () => {
  it('NODE_ENV unset + no creds → THROWS (no silent Noop in a deployed image)', () => {
    // The fail-open the red-team found: an image that forgot ENV NODE_ENV=production
    // ran with NODE_ENV unset → NoopSMSProvider → OTP/signature SMS silently dead.
    expect(() => smsProviderFactory()).toThrow(/refusing to boot/i);
    expect(() => smsProviderFactory()).toThrow(/\(unset\)/);
  });

  it("typo'd NODE_ENV (e.g. 'prod') + no creds → THROWS (only development/test get Noop)", () => {
    process.env['NODE_ENV'] = 'prod';
    expect(() => smsProviderFactory()).toThrow(/refusing to boot/i);
    expect(() => smsProviderFactory()).toThrow(/D\.20/);
  });

  it('NODE_ENV unset but full real creds present → InforuSmsProvider (creds win, no throw)', () => {
    process.env['SMS_PROVIDER_USER'] = 'u';
    process.env['SMS_PROVIDER_TOKEN'] = 't';
    process.env['SMS_PROVIDER_SENDER'] = 's';
    expect(smsProviderFactory()).toBeInstanceOf(InforuSmsProvider);
  });
});
