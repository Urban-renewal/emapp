import { serverEnv } from '@emapp/config';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, TokenExpiredError, type JwtSignOptions } from '@nestjs/jwt';

/**
 * D2-DEF-1 / D.45 — share-access token service (the contractor credential).
 *
 * Mints + verifies the JWT that drives the contractor read-tier. The token
 * is bound to ONE `shares` row and authorises a SCOPED read of that share's
 * project (D.46). Modelled on `SignatureTokenService` (the public-link
 * pattern):
 *   - Distinct AUDIENCE `emapp-share` (vs `emapp-api`/`emapp-provider`/
 *     `emapp-tenant`/`emapp-sign`) → a share token cannot authenticate
 *     against any other tier's endpoints, and no other tier's token passes
 *     the ContractorAuthGuard. This is the structural token-confusion guard.
 *   - 30-day TTL — a contractor reviews a project over weeks; revocation is
 *     immediate via `shares.revoked_at` (checked in the guard on every
 *     request), so a long TTL does not widen the live blast radius.
 *
 * SECRET (flagged for PL hardening): this reuses `JWT_SECRET` (audience
 * isolation is the primary defence). The signature-token tier uses a
 * SEPARATE secret for extra blast-radius isolation; a dedicated
 * `SHARE_TOKEN_SECRET` is the same PL hardening step here (kept out now to
 * avoid a new boot-blocking env dependency before the tier ships). Tracked
 * as a flag — NOT a silent gap.
 */
export const SHARE_TOKEN_ISS = 'emapp';
export const SHARE_TOKEN_AUD = 'emapp-share';
export const SHARE_TOKEN_ALGORITHM = 'HS256' as const;
/** 30 days. Revocation is immediate via shares.revoked_at (guard-checked). */
export const SHARE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ShareTokenPayload {
  /** shares.contractor_id — the external party. */
  sub: string;
  /** shares.project_id — the READ scope. */
  projectId: string;
  /** shares.id — the persistent identity (perms + revocation live here). */
  shareId: string;
  /** project's org — the RLS boundary for every contractor read. */
  orgId: string;
}

export interface VerifiedShareToken extends ShareTokenPayload {
  iat: number;
  exp: number;
}

export type ShareTokenFailReason =
  | 'expired'
  | 'invalid_signature'
  | 'invalid_audience'
  | 'invalid_issuer'
  | 'malformed';

/** Generic 401 to the contractor — no oracle on WHY (expired vs forged). */
export class ShareTokenVerifyError extends UnauthorizedException {
  constructor(public readonly fail: ShareTokenFailReason) {
    super({ error: { code: 'invalid_token' } });
  }
}

@Injectable()
export class ShareTokenService {
  private readonly secret = serverEnv.JWT_SECRET;

  constructor(private readonly jwt: JwtService) {}

  /** Sign a share-access token for a (manager-created) share row. */
  sign(payload: ShareTokenPayload): { token: string; expiresAt: Date } {
    const opts: JwtSignOptions = {
      secret: this.secret,
      algorithm: SHARE_TOKEN_ALGORITHM,
      expiresIn: SHARE_TOKEN_TTL_SECONDS,
      issuer: SHARE_TOKEN_ISS,
      audience: SHARE_TOKEN_AUD,
    };
    const token = this.jwt.sign(payload, opts);
    return { token, expiresAt: new Date(Date.now() + SHARE_TOKEN_TTL_SECONDS * 1000) };
  }

  /** Verify a token presented to a /contractor/* endpoint. Throws
   *  `ShareTokenVerifyError` (→ 401 invalid_token) on any failure. */
  verify(token: string): VerifiedShareToken {
    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify(token, {
        secret: this.secret,
        algorithms: [SHARE_TOKEN_ALGORITHM],
        issuer: SHARE_TOKEN_ISS,
        audience: SHARE_TOKEN_AUD,
      });
    } catch (e: unknown) {
      if (e instanceof TokenExpiredError) throw new ShareTokenVerifyError('expired');
      const msg = e instanceof Error ? e.message : '';
      let fail: ShareTokenFailReason = 'invalid_signature';
      if (/audience/i.test(msg)) fail = 'invalid_audience';
      else if (/issuer/i.test(msg)) fail = 'invalid_issuer';
      else if (/malformed/i.test(msg)) fail = 'malformed';
      throw new ShareTokenVerifyError(fail);
    }
    if (
      typeof payload['sub'] !== 'string' ||
      typeof payload['projectId'] !== 'string' ||
      typeof payload['shareId'] !== 'string' ||
      typeof payload['orgId'] !== 'string' ||
      typeof payload['iat'] !== 'number' ||
      typeof payload['exp'] !== 'number'
    ) {
      throw new ShareTokenVerifyError('malformed');
    }
    return {
      sub: payload['sub'] as string,
      projectId: payload['projectId'] as string,
      shareId: payload['shareId'] as string,
      orgId: payload['orgId'] as string,
      iat: payload['iat'] as number,
      exp: payload['exp'] as number,
    };
  }
}
