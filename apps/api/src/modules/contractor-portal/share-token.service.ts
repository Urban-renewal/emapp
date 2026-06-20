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
 * SECRET (FL-1 / X-S1 hardening, V13): share tokens are now signed with a
 * DEDICATED `SHARE_TOKEN_SECRET`, NOT `JWT_SECRET`. The council split this so a
 * leak of the org-session secret does not compromise the long-lived share
 * credentials (and vice-versa) — audience isolation was the only previous
 * defence; this adds key isolation.
 *
 * DEV FALLBACK: when `SHARE_TOKEN_SECRET` is unset (CI / not-yet-deployed
 * envs), we fall back to `JWT_SECRET` so the process still boots and CI stays
 * green. The prod value is an OWNER-DEPLOY step (Infisical staging+prod).
 *
 * DUAL-VERIFY GRACE WINDOW: `verify()` accepts a token signed with EITHER the
 * new `SHARE_TOKEN_SECRET` OR the legacy `JWT_SECRET` for a deprecation window,
 * so 30-day-TTL tokens minted before the cutover keep working after it.
 * `sign()` always uses the new (preferred) secret. When the fallback is active
 * (SHARE_TOKEN_SECRET unset) both secrets are identical and the dual path
 * collapses to a single verify — still correct.
 */
export const SHARE_TOKEN_ISS = 'emapp';
export const SHARE_TOKEN_AUD = 'emapp-share';
/**
 * FL-2 / additive seam (V13): the audience a future token-EXCHANGE tier would
 * carry (`emapp-exchange`), distinct from the read-credential audience
 * (`emapp-share`). Declared now so the exchange tier (Wave-5) is a pure
 * additive verify-side pin, not a token-confusion retrofit. The exchange tier
 * itself is NOT built here — this is the named seam only. A token carrying this
 * audience does NOT pass `verify()` below (which pins `SHARE_TOKEN_AUD`).
 */
export const SHARE_TOKEN_AUD_EXCHANGE = 'emapp-exchange';
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
  /** Preferred signing secret: the dedicated SHARE_TOKEN_SECRET, falling back
   *  to JWT_SECRET when unset (CI / pre-deploy bridge). New tokens are ALWAYS
   *  signed with this. */
  private readonly signingSecret = serverEnv.SHARE_TOKEN_SECRET ?? serverEnv.JWT_SECRET;
  /** Legacy secret kept ONLY for the dual-verify grace window — tokens minted
   *  before the split were signed with JWT_SECRET. When the dedicated secret is
   *  unset the two are identical and the second verify attempt is a redundant
   *  no-op (deduped below). */
  private readonly legacySecret = serverEnv.JWT_SECRET;

  /** Distinct verify secrets, in preference order, de-duplicated so the common
   *  fallback case (SHARE_TOKEN_SECRET unset → both equal JWT_SECRET) does ONE
   *  verify, not two. */
  private get verifySecrets(): string[] {
    return this.signingSecret === this.legacySecret
      ? [this.signingSecret]
      : [this.signingSecret, this.legacySecret];
  }

  constructor(private readonly jwt: JwtService) {}

  /** Sign a share-access token for a (manager-created) share row. Always uses
   *  the preferred (new) secret. */
  sign(payload: ShareTokenPayload): { token: string; expiresAt: Date } {
    const opts: JwtSignOptions = {
      secret: this.signingSecret,
      algorithm: SHARE_TOKEN_ALGORITHM,
      expiresIn: SHARE_TOKEN_TTL_SECONDS,
      issuer: SHARE_TOKEN_ISS,
      audience: SHARE_TOKEN_AUD,
    };
    const token = this.jwt.sign(payload, opts);
    return { token, expiresAt: new Date(Date.now() + SHARE_TOKEN_TTL_SECONDS * 1000) };
  }

  /** Verify a token presented to a /contractor/* endpoint. Throws
   *  `ShareTokenVerifyError` (→ 401 invalid_token) on any failure.
   *
   *  DUAL-VERIFY GRACE: tries the new secret first, then the legacy JWT_SECRET.
   *  Only a SIGNATURE mismatch (`invalid_signature`) is retried against the
   *  legacy secret — `expired` / `invalid_audience` / `invalid_issuer` /
   *  `malformed` are intrinsic to the token (secret-independent) and fail fast,
   *  preserving the no-oracle, generic-401 posture. The deprecation window
   *  closes by removing JWT_SECRET from `verifySecrets` once all pre-split
   *  tokens (≤30-day TTL) have aged out. */
  verify(token: string): VerifiedShareToken {
    let payload: Record<string, unknown> | undefined;
    let lastFail: ShareTokenFailReason = 'invalid_signature';
    const secrets = this.verifySecrets;
    for (let i = 0; i < secrets.length; i++) {
      try {
        payload = this.jwt.verify<Record<string, unknown>>(token, {
          secret: secrets[i],
          algorithms: [SHARE_TOKEN_ALGORITHM],
          issuer: SHARE_TOKEN_ISS,
          audience: SHARE_TOKEN_AUD,
        });
        break;
      } catch (e: unknown) {
        if (e instanceof TokenExpiredError) throw new ShareTokenVerifyError('expired');
        const msg = e instanceof Error ? e.message : '';
        let fail: ShareTokenFailReason = 'invalid_signature';
        if (/audience/i.test(msg)) fail = 'invalid_audience';
        else if (/issuer/i.test(msg)) fail = 'invalid_issuer';
        else if (/malformed/i.test(msg)) fail = 'malformed';
        // Intrinsic (secret-independent) failures fail fast — no point retrying
        // a different key. Only a signature mismatch warrants the legacy retry.
        if (fail !== 'invalid_signature') throw new ShareTokenVerifyError(fail);
        lastFail = fail;
      }
    }
    if (!payload) throw new ShareTokenVerifyError(lastFail);
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
