/**
 * SEC #15 — the Pages Function proxy logs the upstream URL when a fetch
 * throws (`console.error('[proxy] upstream fetch threw', { url })`). That
 * URL carries the signing JWT (`/sign/<jwt>`) and any `?token=` / `?otp=`
 * / `?code=` query value. Without scrubbing it is a SECOND plaintext
 * credential sink besides the API's pino redactor.
 *
 * `scrubUrlForLog` must mask the token while keeping the route legible.
 *
 * Placeholder token `HEADERseg.PAYLOADseg.SIGseg` is used deliberately
 * (NOT a realistic eyJ… JWT) so GitGuardian / secret scanners don't flag
 * this fixture.
 */
import { describe, expect, it } from 'vitest';

import { scrubUrlForLog } from './route';

const BASE = 'https://emapp-api.railway.internal';
const PLACEHOLDER_JWT = 'HEADERseg.PAYLOADseg.SIGseg';

describe('scrubUrlForLog (SEC #15 — token must not reach Pages logs)', () => {
  it('masks the /sign/<jwt> path segment but keeps the route legible', () => {
    const out = scrubUrlForLog(`${BASE}/api/v1/sign/${PLACEHOLDER_JWT}`);
    expect(out).toBe(`${BASE}/api/v1/sign/[REDACTED]`);
    // Token gone; route still readable.
    expect(out).not.toContain(PLACEHOLDER_JWT);
    expect(out).toContain('/api/v1/sign/');
  });

  it('masks a ?token= query value while preserving the path + key', () => {
    const out = scrubUrlForLog(`${BASE}/api/v1/reset-password?token=SECRET123`);
    expect(out).toBe(`${BASE}/api/v1/reset-password?token=[REDACTED]`);
    expect(out).not.toContain('SECRET123');
    expect(out).toContain('/api/v1/reset-password');
  });

  it('masks ?otp= and ?code= values (case-insensitive key)', () => {
    expect(scrubUrlForLog(`${BASE}/api/v1/x?otp=998877`)).toBe(`${BASE}/api/v1/x?otp=[REDACTED]`);
    expect(scrubUrlForLog(`${BASE}/api/v1/x?CODE=abc123`)).toBe(`${BASE}/api/v1/x?CODE=[REDACTED]`);
  });

  it('masks sensitive values among other (kept) query params', () => {
    const out = scrubUrlForLog(`${BASE}/api/v1/x?page=2&token=SECRET&limit=20`);
    expect(out).toBe(`${BASE}/api/v1/x?page=2&token=[REDACTED]&limit=20`);
    expect(out).not.toContain('SECRET');
    // Non-sensitive params survive — route stays legible for ops.
    expect(out).toContain('page=2');
    expect(out).toContain('limit=20');
  });

  it('scrubs BOTH a /sign/<jwt> path AND a ?token= query in one URL', () => {
    const out = scrubUrlForLog(`${BASE}/api/v1/sign/${PLACEHOLDER_JWT}?token=SECRET`);
    expect(out).toBe(`${BASE}/api/v1/sign/[REDACTED]?token=[REDACTED]`);
    expect(out).not.toContain(PLACEHOLDER_JWT);
    expect(out).not.toContain('SECRET');
  });

  it('leaves a token-free URL untouched (no over-redaction)', () => {
    const url = `${BASE}/api/v1/projects?page=2&limit=20`;
    expect(scrubUrlForLog(url)).toBe(url);
  });
});
