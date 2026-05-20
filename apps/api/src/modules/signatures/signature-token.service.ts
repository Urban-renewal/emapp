import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService, TokenExpiredError, type JwtSignOptions } from '@nestjs/jwt';

/** DI token for the SIGNATURE_TOKEN_SECRET value. Injected so tests can
 *  override without mutating process.env (same pattern as the storage
 *  STORAGE_PROVIDER injection). The module-side factory reads
 *  `serverEnv.SIGNATURE_TOKEN_SECRET` and refuses to boot in any env
 *  where it's missing — see signatures.module.ts. */
export const SIGNATURE_TOKEN_SECRET = Symbol('SIGNATURE_TOKEN_SECRET');

/** Phase 5 — signature-link token service (docs/03 §9).
 *
 * Mints + verifies the JWTs that drive the public-link signing flow.
 * SEPARATE JwtService instance from the org/provider/tenant access tokens
 * (different secret, different audience). The separation is structural,
 * not just convention:
 *   - Different secret (`SIGNATURE_TOKEN_SECRET`, not `JWT_SECRET`) → a
 *     leak of one doesn't compromise the other.
 *   - Different audience (`emapp-sign`, distinct from D.29 audiences
 *     `emapp-api`/`emapp-provider`/`emapp-tenant`) → a sign-token cannot
 *     authenticate against any other endpoint, and an org/provider/tenant
 *     token cannot pass `/sign/:token`.
 *   - Different TTL (7 days vs 15 min) → reflects the very different
 *     threat models.
 *
 * `jti` is the atomic single-use guard's key — written to
 * `signature_requests.jti` (UNIQUE) and consumed via the atomic UPDATE
 * `... WHERE jti=$1 AND status='pending'`. */

export const SIGNATURE_TOKEN_ISS = 'emapp';
export const SIGNATURE_TOKEN_AUD = 'emapp-sign';
export const SIGNATURE_TOKEN_ALGORITHM = 'HS256' as const;
/** 7 days, docs/03 §9. */
export const SIGNATURE_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SignatureTokenPayload {
  /** JWT id — the atomic single-use key. */
  jti: string;
  /** signature_requests.id */
  sub: string;
  orgId: string;
  documentId: string;
  ownerId: string;
}

export interface VerifiedSignatureToken extends SignatureTokenPayload {
  iat: number;
  exp: number;
}

/** Discriminator for the public sign endpoint's `invalid_token` mapping.
 *  We DO distinguish internally (for audit/forensics) between "expired"
 *  and "invalid signature", but the response code stays generic
 *  `invalid_token` for the resident — no oracle. */
export type SignatureTokenFailReason =
  | 'expired'
  | 'invalid_signature'
  | 'invalid_audience'
  | 'invalid_issuer'
  | 'malformed';

export class SignatureTokenVerifyError extends UnauthorizedException {
  constructor(public readonly fail: SignatureTokenFailReason) {
    // Resident-facing response is always the same generic code.
    super({ error: { code: 'invalid_token' } });
  }
}

@Injectable()
export class SignatureTokenService {
  private readonly logger = new Logger(SignatureTokenService.name);
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    @Inject(SIGNATURE_TOKEN_SECRET) secret: string,
  ) {
    if (!secret || secret.length < 44) {
      // Same fail-fast governance as the email provider / R2 provider:
      // refuse to construct without a real secret. The module-side
      // factory is where the env value comes from — keeping that read
      // OUT of this class makes testing trivial and isolation cleaner.
      throw new Error(
        'SignatureTokenService: refusing to start — SIGNATURE_TOKEN_SECRET ' +
          'is not configured (Infisical, env: dev/staging/prod). It MUST be ' +
          'separate from JWT_SECRET (docs/03 §9). Generate one with: ' +
          "node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
      );
    }
    this.secret = secret;
  }

  /** Sign a token for a (manager-created) signature request.
   *  `jti` is server-generated (CSPRNG UUID) so the caller never picks
   *  it. We pass it ONLY via the `jwtid` option — jsonwebtoken writes
   *  it into the resulting JWT's `jti` claim automatically. Passing it
   *  again in the payload would error ("payload already has jti"). */
  sign(payload: Omit<SignatureTokenPayload, 'jti'>): {
    token: string;
    jti: string;
    expiresAt: Date;
  } {
    const jti = randomUUID();
    const opts: JwtSignOptions = {
      secret: this.secret,
      algorithm: SIGNATURE_TOKEN_ALGORITHM,
      expiresIn: SIGNATURE_TOKEN_TTL_SECONDS,
      issuer: SIGNATURE_TOKEN_ISS,
      audience: SIGNATURE_TOKEN_AUD,
      jwtid: jti,
    };
    const token = this.jwt.sign(payload, opts);
    const expiresAt = new Date(Date.now() + SIGNATURE_TOKEN_TTL_SECONDS * 1000);
    return { token, jti, expiresAt };
  }

  /** Verify a token presented at /sign/:token. Throws
   *  `SignatureTokenVerifyError` on any failure — the controller maps it
   *  to 401 `invalid_token`. */
  verify(token: string): VerifiedSignatureToken {
    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify(token, {
        secret: this.secret,
        algorithms: [SIGNATURE_TOKEN_ALGORITHM],
        issuer: SIGNATURE_TOKEN_ISS,
        audience: SIGNATURE_TOKEN_AUD,
      });
    } catch (e: unknown) {
      if (e instanceof TokenExpiredError) {
        throw new SignatureTokenVerifyError('expired');
      }
      // jsonwebtoken's `JsonWebTokenError.message` carries discriminators
      // like "invalid signature" / "jwt audience invalid" / "jwt issuer
      // invalid" / "jwt malformed". Map them honestly (for internal
      // logging) but echo the same generic response to the resident.
      const msg = e instanceof Error ? e.message : '';
      let fail: SignatureTokenFailReason = 'invalid_signature';
      if (/audience/i.test(msg)) fail = 'invalid_audience';
      else if (/issuer/i.test(msg)) fail = 'invalid_issuer';
      else if (/malformed/i.test(msg)) fail = 'malformed';
      throw new SignatureTokenVerifyError(fail);
    }
    // Structural check on the payload shape. A token signed by us but
    // with a bogus payload should NOT panic the service — return the
    // same generic 401.
    if (
      typeof payload['jti'] !== 'string' ||
      typeof payload['sub'] !== 'string' ||
      typeof payload['orgId'] !== 'string' ||
      typeof payload['documentId'] !== 'string' ||
      typeof payload['ownerId'] !== 'string' ||
      typeof payload['iat'] !== 'number' ||
      typeof payload['exp'] !== 'number'
    ) {
      throw new SignatureTokenVerifyError('malformed');
    }
    return {
      jti: payload['jti'] as string,
      sub: payload['sub'] as string,
      orgId: payload['orgId'] as string,
      documentId: payload['documentId'] as string,
      ownerId: payload['ownerId'] as string,
      iat: payload['iat'] as number,
      exp: payload['exp'] as number,
    };
  }
}
