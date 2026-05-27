import { Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { TenantAuthGuard, type TenantTokenPayload } from '../auth/tenant/tenant-auth.guard';

import { PortalService } from './portal.service';

/**
 * Tenant Portal — own-data view (D.40, V11 B.S4).
 *
 * All routes under `/api/v1/portal/*`, all GET, all guarded by
 * `TenantAuthGuard` (audience=`emapp-tenant`, role=`tenant`,
 * type=`tenant_access` — see tenant-auth.guard.ts). The guard
 * attaches `req.tenant: TenantTokenPayload` whose `sub` is the
 * owner.id; service methods scope every query to that id.
 *
 * Tier isolation: the org `AuthorizationGuard` is intentionally NOT
 * stacked here — POLICY (apps/api/src/common/authz/policy.ts) has
 * no `portal` resource. Cross-tier defence is structural: an org
 * access_token has a different JWT audience (`emapp-api` per D.29)
 * and the TenantAuthGuard rejects it at verify().
 *
 * No write endpoints in V11 (D.40 — read-only own-data view).
 */
@Controller('portal')
@UseGuards(TenantAuthGuard)
export class PortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('me')
  async getMe(@Req() req: FastifyRequest) {
    const tenant = (req as FastifyRequest & { tenant: TenantTokenPayload }).tenant;
    return { data: await this.portal.getMe(tenant) };
  }

  @Get('apartment')
  async getApartments(@Req() req: FastifyRequest) {
    const tenant = (req as FastifyRequest & { tenant: TenantTokenPayload }).tenant;
    return this.portal.getApartments(tenant);
  }

  @Get('documents')
  async getDocuments(@Req() req: FastifyRequest) {
    const tenant = (req as FastifyRequest & { tenant: TenantTokenPayload }).tenant;
    return this.portal.getDocuments(tenant);
  }

  @Get('signatures')
  async getSignatures(@Req() req: FastifyRequest) {
    const tenant = (req as FastifyRequest & { tenant: TenantTokenPayload }).tenant;
    return this.portal.getSignatures(tenant);
  }

  /**
   * `POST /portal/logout` (Wave 4 M-1) — tenant-initiated revoke. Soft
   * revokes the tenant_sessions row bound to this JWT's `sid`. Clears
   * the `tenant_access_token` cookie so subsequent requests fail at
   * the guard with `missing_token`. Returns 204 No Content; idempotent
   * (a second call after revoke just no-ops).
   */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const tenant = (req as FastifyRequest & { tenant: TenantTokenPayload }).tenant;
    await this.portal.logout(tenant);
    // Clear the cookie (best-effort — the structural revoke is the DB
    // row + cache flush; this just hides the dead token from the UA).
    res.clearCookie('tenant_access_token', { path: '/' });
  }
}
