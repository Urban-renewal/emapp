/**
 * §RED-1 P0 closure pin — URL scheme allowlist.
 *
 * Default `z.string().url()` accepts ANY scheme including the dangerous
 * ones. We pin every URL field in the wire contract to https (or
 * http/https for upload URLs that may target localhost in dev).
 *
 * This spec is the contract: removing the scheme check or widening
 * the allowlist fails CI.
 */
import { describe, expect, it } from 'vitest';

import { HttpOrHttpsUrlSchema, HttpsUrlSchema, WhatsAppDeepLinkSchema } from './safe-url';

describe('HttpsUrlSchema — §RED-1', () => {
  it('1) accepts https://', () => {
    expect(HttpsUrlSchema.safeParse('https://r2.example/blob?sig=abc').success).toBe(true);
  });
  it('2) rejects http://', () => {
    expect(HttpsUrlSchema.safeParse('http://r2.example').success).toBe(false);
  });
  it('3) rejects javascript:alert(1)', () => {
    expect(HttpsUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
  });
  it('4) rejects data:text/html,...', () => {
    expect(HttpsUrlSchema.safeParse('data:text/html,<script>alert(1)</script>').success).toBe(
      false,
    );
  });
  it('5) rejects vbscript:', () => {
    expect(HttpsUrlSchema.safeParse('vbscript:alert(1)').success).toBe(false);
  });
  it('6) rejects file://', () => {
    expect(HttpsUrlSchema.safeParse('file:///etc/passwd').success).toBe(false);
  });
  it('7) rejects empty + plain string', () => {
    expect(HttpsUrlSchema.safeParse('').success).toBe(false);
    expect(HttpsUrlSchema.safeParse('not a url').success).toBe(false);
  });
});

describe('HttpOrHttpsUrlSchema — §RED-1', () => {
  it('8) accepts https://', () => {
    expect(HttpOrHttpsUrlSchema.safeParse('https://r2.example').success).toBe(true);
  });
  it('9) accepts http:// (dev / mock)', () => {
    expect(HttpOrHttpsUrlSchema.safeParse('http://localhost:9000').success).toBe(true);
  });
  it('10) rejects javascript: even on the looser schema', () => {
    expect(HttpOrHttpsUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
  });
  it('11) rejects data:', () => {
    expect(HttpOrHttpsUrlSchema.safeParse('data:text/html,...').success).toBe(false);
  });
});

describe('WhatsAppDeepLinkSchema — §RED-1', () => {
  it('12) accepts https://wa.me/...', () => {
    expect(WhatsAppDeepLinkSchema.safeParse('https://wa.me/972500000000?text=hi').success).toBe(
      true,
    );
  });
  it('13) rejects javascript:', () => {
    expect(WhatsAppDeepLinkSchema.safeParse('javascript:alert(1)').success).toBe(false);
  });
});
