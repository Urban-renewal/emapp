/**
 * FL-1 / X-S1 (V13) — share-token secret split + dual-verify grace.
 *
 * Asserts:
 *   - A token signed with the NEW (dedicated) secret verifies.
 *   - A LEGACY token signed with JWT_SECRET still verifies during the grace
 *     window (the dual-verify path).
 *   - A token signed with an UNRELATED secret is rejected (generic 401).
 *   - sign() uses the new secret: a verifier holding ONLY the new secret
 *     accepts; one holding ONLY the legacy secret rejects (proving the cutover).
 */
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import {
  SHARE_TOKEN_ALGORITHM,
  SHARE_TOKEN_AUD,
  SHARE_TOKEN_ISS,
  SHARE_TOKEN_TTL_SECONDS,
  ShareTokenService,
  ShareTokenVerifyError,
  type ShareTokenPayload,
} from './share-token.service';

// 44+ char base64url secrets (the schema floor). Distinct values.
const NEW_SECRET = 'new_share_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEGACY_SECRET = 'legacy_jwt_secret_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNRELATED_SECRET = 'unrelated_secret_cccccccccccccccccccccccccccccccccccccc';

const PAYLOAD: ShareTokenPayload = {
  sub: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  shareId: '00000000-0000-4000-8000-000000000003',
  orgId: '00000000-0000-4000-8000-000000000004',
};

function signWith(secret: string): string {
  const jwt = new JwtService({ secret });
  return jwt.sign(PAYLOAD, {
    secret,
    algorithm: SHARE_TOKEN_ALGORITHM,
    expiresIn: SHARE_TOKEN_TTL_SECONDS,
    issuer: SHARE_TOKEN_ISS,
    audience: SHARE_TOKEN_AUD,
  });
}

/** Build a service whose signing/legacy secrets are injected directly (avoids
 *  mutating process.env / serverEnv). */
function svc(signingSecret: string, legacySecret: string): ShareTokenService {
  const s = new ShareTokenService(new JwtService({}));
  // The class reads serverEnv at field-init; override the resolved privates for
  // a deterministic, env-independent test of the dual-verify logic itself.
  Object.defineProperty(s, 'signingSecret', { value: signingSecret });
  Object.defineProperty(s, 'legacySecret', { value: legacySecret });
  return s;
}

describe('ShareTokenService — secret split + dual-verify grace (FL-1/X-S1)', () => {
  it('verifies a token signed with the NEW dedicated secret', () => {
    const s = svc(NEW_SECRET, LEGACY_SECRET);
    const token = signWith(NEW_SECRET);
    const v = s.verify(token);
    expect(v.shareId).toBe(PAYLOAD.shareId);
    expect(v.orgId).toBe(PAYLOAD.orgId);
  });

  it('GRACE: still verifies a LEGACY token signed with JWT_SECRET', () => {
    const s = svc(NEW_SECRET, LEGACY_SECRET);
    const legacyToken = signWith(LEGACY_SECRET);
    const v = s.verify(legacyToken);
    expect(v.shareId).toBe(PAYLOAD.shareId);
  });

  it('rejects a token signed with an UNRELATED secret (generic 401)', () => {
    const s = svc(NEW_SECRET, LEGACY_SECRET);
    const token = signWith(UNRELATED_SECRET);
    expect(() => s.verify(token)).toThrow(ShareTokenVerifyError);
  });

  it('sign() uses the NEW secret — accepted by new-only, rejected by legacy-only', () => {
    const signer = svc(NEW_SECRET, NEW_SECRET); // signs + verifies with NEW only
    const { token } = signer.sign(PAYLOAD);
    // A verifier that only knows the NEW secret accepts.
    expect(svc(NEW_SECRET, NEW_SECRET).verify(token).shareId).toBe(PAYLOAD.shareId);
    // A verifier that only knows the LEGACY secret rejects (proves new-secret signing).
    expect(() => svc(LEGACY_SECRET, LEGACY_SECRET).verify(token)).toThrow(ShareTokenVerifyError);
  });

  it('fallback (secrets identical) collapses to a single verify and still works', () => {
    const s = svc(NEW_SECRET, NEW_SECRET);
    const { token } = s.sign(PAYLOAD);
    expect(s.verify(token).shareId).toBe(PAYLOAD.shareId);
  });

  it('wrong audience fails fast (no legacy retry, generic 401)', () => {
    const jwt = new JwtService({ secret: NEW_SECRET });
    const wrongAud = jwt.sign(PAYLOAD, {
      secret: NEW_SECRET,
      algorithm: SHARE_TOKEN_ALGORITHM,
      expiresIn: SHARE_TOKEN_TTL_SECONDS,
      issuer: SHARE_TOKEN_ISS,
      audience: 'emapp-api',
    });
    const s = svc(NEW_SECRET, LEGACY_SECRET);
    try {
      s.verify(wrongAud);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ShareTokenVerifyError);
      expect((e as ShareTokenVerifyError).fail).toBe('invalid_audience');
    }
  });
});
