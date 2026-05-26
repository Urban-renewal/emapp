import { Controller, Get, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { ProviderAuthGuard } from './provider-auth.guard';
import { ProviderAuthService, type ProviderTokenPayload } from './provider-auth.service';

/**
 * `GET /api/v1/provider/me` — Provider Admin self-identity.
 *
 * V10-S1 closure (H1 Provider FE topology gap): the FE
 * `provider/layout.tsx` calls this Server Action equivalent to gate
 * the entire `/provider/*` subtree. Without it, the FE was reading the
 * org-tier `/me` (which returns only manager/agent/viewer roles) and
 * the Provider Admin dashboard was unreachable in prod.
 *
 * **Tier isolation** (D.29):
 *   - Gated by `ProviderAuthGuard` — JWT audience `emapp-provider`
 *     verified; org-tier and tenant-tier tokens structurally rejected
 *     (not just a payload.type check).
 *   - Cookie name pinned to `provider_access_token` (different scope
 *     from `access_token`; both can coexist on the same browser without
 *     confusion).
 *
 * **Error envelope** (D.16):
 *   - 401 `missing_token` — no provider_access_token cookie + no Bearer
 *     header (from guard)
 *   - 401 `invalid_token` — JWT verify failed, wrong audience, wrong
 *     `type` claim, OR `role` claim not `provider_admin` (from guard)
 *   - 401 `session_revoked` — JWT verifies but `sid` no longer in the
 *     active set (logout, refresh-token reuse purged the chain)
 *   - 401 `invalid_token` — JWT verifies + session active, but the
 *     provider_users row was deleted concurrently OR disabled
 *     (`disabledAt` set) OR `role` column corrupted (anti-enum: same
 *     code as expired/malformed; no oracle).
 *
 * **No audit row written** — see ProviderAuthService.getProfile()
 * docstring. Identity check on every page nav; the cross-tenant audit
 * obligation (D.37) is satisfied by login + each subsequent cross-tenant
 * call, not by self-identity probes.
 *
 * **Throttle**: inherits the global throttler (apps/api/src/main.ts);
 * no per-route override. Provider Admins are <5 in a system; even a
 * pathological client-side polling bug bounded by global 100/min.
 */
@Controller('provider/me')
@UseGuards(ProviderAuthGuard)
export class ProviderMeController {
  constructor(private readonly svc: ProviderAuthService) {}

  @Get()
  async getMe(@Req() req: FastifyRequest) {
    const provider = (req as FastifyRequest & { providerUser: ProviderTokenPayload }).providerUser;
    const profile = await this.svc.getProfile(provider.sub);
    if (!profile) {
      // Provider user was deleted / disabled / corrupted-role since
      // login. Map to the same 401 envelope the guard uses on JWT
      // failures — anti-enum (Doc 07 §6.12.1): an attacker cannot
      // distinguish "user removed" from "token expired" from "wrong
      // audience". All three look identical on the wire.
      //
      // We deliberately do NOT also revoke the session here (would be
      // a HIGH-with-plan improvement: a disabled user could continue
      // hitting cross-tenant endpoints until their JWT expires, ~30
      // min). Reason: session revocation requires a tx + cache flush;
      // doing it inside an identity endpoint adds runtime cost on the
      // happy path (a future write would have to guard against this
      // race) and the existing audit trail captures the cross-tenant
      // access. Tracked as a follow-up enhancement.
      throw new UnauthorizedException({ error: { code: 'invalid_token' } });
    }
    return { data: profile };
  }
}
