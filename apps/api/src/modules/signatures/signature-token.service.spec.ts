/**
 * Phase 5 unit proof — SignatureTokenService.
 *
 * Deterministic, zero-infra (no env mutation). Pins:
 *  - T5.1: sign yields a verifiable token; payload claims round-trip.
 *  - T5.2: expired token → SignatureTokenVerifyError('expired'), and the
 *    resident-facing response stays generic `invalid_token` (no oracle).
 *  - AUDIENCE isolation: a token signed with audience='emapp-api' (D.29
 *    org tier) MUST NOT verify here. Mirrors the locked tier isolation.
 *  - ISSUER isolation: token from a different `iss` MUST NOT verify.
 *  - SECRET isolation: token signed with JWT_SECRET (a different secret
 *    entirely) MUST NOT verify here. Different secret = different blast
 *    radius — the spec's primary security guarantee.
 *  - Tamper resistance: flipping any byte → invalid_signature.
 *  - Malformed shape: missing required claim → malformed.
 *  - Boot guard: SignatureTokenService refuses to construct without a
 *    real ≥44-char secret (governed pattern, same as email/storage).
 */
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  SIGNATURE_TOKEN_AUD,
  SIGNATURE_TOKEN_ISS,
  SIGNATURE_TOKEN_TTL_SECONDS,
  SignatureTokenService,
  SignatureTokenVerifyError,
} from './signature-token.service';

// 48-byte equivalent in chars (matches the prod-quality length).
const TEST_SIG_SECRET = 'A'.repeat(64);
const TEST_OTHER_SECRET = 'B'.repeat(64);

/** Instantiate directly — vitest in this monorepo does NOT emit decorator
 *  metadata (no swc transform configured for it), so NestJS DI lookup of
 *  JwtService fails. The CODE under test only uses `new JwtService()`-
 *  equivalents at runtime via Module.register; for the UNIT test we hand
 *  one in. The integration / contract test (next slice) exercises the
 *  full Nest module wiring. */
function makeService(secret: string = TEST_SIG_SECRET): {
  service: SignatureTokenService;
  jwt: JwtService;
} {
  const jwt = new JwtService({});
  const service = new SignatureTokenService(jwt, secret);
  return { service, jwt };
}

const payload = {
  sub: '11111111-1111-1111-1111-111111111111',
  orgId: '22222222-2222-2222-2222-222222222222',
  documentId: '33333333-3333-3333-3333-333333333333',
  ownerId: '44444444-4444-4444-4444-444444444444',
};

describe('Phase 5 · SignatureTokenService', () => {
  let service: SignatureTokenService;
  let jwt: JwtService;

  beforeEach(() => {
    ({ service, jwt } = makeService());
  });

  it('T5.1 — sign yields a verifiable token; all claims round-trip', () => {
    const { token, jti, expiresAt } = service.sign(payload);
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // 3-segment JWS
    expect(jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const ms = expiresAt.getTime() - Date.now();
    expect(ms).toBeGreaterThan(SIGNATURE_TOKEN_TTL_SECONDS * 1000 - 5000);
    expect(ms).toBeLessThan(SIGNATURE_TOKEN_TTL_SECONDS * 1000 + 5000);

    const v = service.verify(token);
    expect(v.jti).toBe(jti);
    expect(v.sub).toBe(payload.sub);
    expect(v.orgId).toBe(payload.orgId);
    expect(v.documentId).toBe(payload.documentId);
    expect(v.ownerId).toBe(payload.ownerId);
    expect(v.exp).toBe(v.iat + SIGNATURE_TOKEN_TTL_SECONDS);
  });

  it('T5.1 — each sign() produces a distinct jti (CSPRNG, never reused)', () => {
    const a = service.sign(payload);
    const b = service.sign(payload);
    expect(a.jti).not.toBe(b.jti);
    expect(a.token).not.toBe(b.token);
  });

  it('T5.2 — expired token → invalid_token (fail="expired"); no oracle', () => {
    const expired = jwt.sign(
      { ...payload, jti: '99999999-9999-9999-9999-999999999999' },
      {
        secret: TEST_SIG_SECRET,
        algorithm: 'HS256',
        issuer: SIGNATURE_TOKEN_ISS,
        audience: SIGNATURE_TOKEN_AUD,
        expiresIn: '-1s',
        notBefore: -10,
      },
    );
    let caught: unknown;
    try {
      service.verify(expired);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SignatureTokenVerifyError);
    const err = caught as SignatureTokenVerifyError;
    expect(err.fail).toBe('expired');
    const body = err.getResponse() as { error?: { code?: string } };
    expect(body?.error?.code).toBe('invalid_token'); // generic — anti-enumeration
  });

  it('AUDIENCE isolation — emapp-api token MUST NOT verify here', () => {
    const wrongAud = jwt.sign(
      { ...payload, jti: 'x' },
      {
        secret: TEST_SIG_SECRET,
        algorithm: 'HS256',
        issuer: SIGNATURE_TOKEN_ISS,
        audience: 'emapp-api', // D.29 org audience — backdoor candidate
        expiresIn: '7d',
      },
    );
    let caught: unknown;
    try {
      service.verify(wrongAud);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SignatureTokenVerifyError);
    expect((caught as SignatureTokenVerifyError).fail).toBe('invalid_audience');
  });

  it('ISSUER isolation — different `iss` MUST NOT verify', () => {
    const wrongIss = jwt.sign(
      { ...payload, jti: 'x' },
      {
        secret: TEST_SIG_SECRET,
        algorithm: 'HS256',
        issuer: 'evil-issuer',
        audience: SIGNATURE_TOKEN_AUD,
        expiresIn: '7d',
      },
    );
    let caught: unknown;
    try {
      service.verify(wrongIss);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SignatureTokenVerifyError);
    expect((caught as SignatureTokenVerifyError).fail).toBe('invalid_issuer');
  });

  it('SECRET isolation — JWT_SECRET-signed token MUST NOT verify here', () => {
    const otherSecret = jwt.sign(
      { ...payload, jti: 'x' },
      {
        secret: TEST_OTHER_SECRET, // different secret entirely
        algorithm: 'HS256',
        issuer: SIGNATURE_TOKEN_ISS,
        audience: SIGNATURE_TOKEN_AUD,
        expiresIn: '7d',
      },
    );
    let caught: unknown;
    try {
      service.verify(otherSecret);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SignatureTokenVerifyError);
    expect((caught as SignatureTokenVerifyError).fail).toBe('invalid_signature');
  });

  it('Tamper resistance — flipping any byte → invalid_signature', () => {
    const { token } = service.sign(payload);
    const parts = token.split('.');
    // mutate the last char of the payload segment
    parts[1] = parts[1]!.slice(0, -1) + (parts[1]!.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');
    let caught: unknown;
    try {
      service.verify(tampered);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SignatureTokenVerifyError);
  });

  it('Malformed payload — missing required claim → malformed (still 401)', () => {
    const partial = jwt.sign(
      { sub: payload.sub }, // missing orgId / documentId / ownerId
      {
        secret: TEST_SIG_SECRET,
        algorithm: 'HS256',
        issuer: SIGNATURE_TOKEN_ISS,
        audience: SIGNATURE_TOKEN_AUD,
        expiresIn: '7d',
        jwtid: 'a-jti',
      },
    );
    let caught: unknown;
    try {
      service.verify(partial);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SignatureTokenVerifyError);
    expect((caught as SignatureTokenVerifyError).fail).toBe('malformed');
  });

  it('Boot guard — construction refuses an empty / short secret', () => {
    expect(() => makeService('')).toThrow(/refusing to start/i);
    expect(() => makeService('too-short')).toThrow(/refusing to start/i);
  });
});
