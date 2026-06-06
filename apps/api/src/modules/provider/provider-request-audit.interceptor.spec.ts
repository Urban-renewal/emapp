/**
 * L1 — the provider request-audit interceptor stores the request URL in the
 * provider_audit_log metadata. `scrubUrlForAudit` keeps the path + query-param
 * KEYS (forensic: which filter/cursor was probed) but redacts every query
 * VALUE, so a future provider endpoint that accepts PII in a query param can
 * never leak it into the audit trail. These tests pin that contract.
 */
import { describe, expect, it } from 'vitest';

import { scrubUrlForAudit } from './provider-request-audit.interceptor';

describe('scrubUrlForAudit (L1 — no query-value PII in provider audit)', () => {
  it('returns a path with no query string unchanged', () => {
    expect(scrubUrlForAudit('/api/v1/provider/tenants')).toBe('/api/v1/provider/tenants');
  });

  it('keeps UUID path params (not PII) intact', () => {
    const url = '/api/v1/provider/tenants/3f1c8a2e-0000-4000-8000-000000000001';
    expect(scrubUrlForAudit(url)).toBe(url);
  });

  it('redacts every query VALUE but keeps the KEYS', () => {
    expect(scrubUrlForAudit('/api/v1/provider/tenants?q=Cohen&cursor=abc123')).toBe(
      '/api/v1/provider/tenants?q=[redacted]&cursor=[redacted]',
    );
  });

  it('redacts a value that itself contains an "=" (e.g. base64 cursor)', () => {
    expect(scrubUrlForAudit('/x?cursor=YQ==&limit=25')).toBe(
      '/x?cursor=[redacted]&limit=[redacted]',
    );
  });

  it('handles a valueless flag param and an empty query', () => {
    expect(scrubUrlForAudit('/x?flag')).toBe('/x?flag');
    expect(scrubUrlForAudit('/x?')).toBe('/x');
  });

  it('never echoes a PII-shaped value (national_id / phone) back', () => {
    const out = scrubUrlForAudit('/api/v1/provider/search?national_id=123456789&phone=0501234567');
    expect(out).toBe('/api/v1/provider/search?national_id=[redacted]&phone=[redacted]');
    expect(out).not.toMatch(/\d{9}/);
    expect(out).not.toMatch(/05\d{8}/);
  });
});
