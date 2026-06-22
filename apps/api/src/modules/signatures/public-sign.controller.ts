import {
  PUBLIC_SIGN_SVG_MAX_BYTES,
  PublicSignSubmitInput,
  type PublicSignSubmit,
} from '@emapp/shared-types';
import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { safeDownloadFilename } from '../documents/storage';

import { PublicSignService } from './public-sign.service';

/** Public-facing signing controller.
 *
 * NO `AuthGuard`, NO `TenantGuard`, NO `AuthorizationGuard` — by design.
 * The JWT (`:token` path param) IS the credential. The path is
 * deliberately rooted at `/sign/*` (not `/signature-requests/*`) so the
 * URL itself reads as a public action to a resident clicking from
 * Email/WhatsApp, and so the no-auth route is unambiguous to reviewers.
 *
 * Rate limits per docs/03 §9 (T5.6): 5 POST/IP/hour. GET is more
 * permissive (30/IP/hour) because residents may reload the page.
 */
@Controller('sign')
export class PublicSignController {
  constructor(private readonly publicSign: PublicSignService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 60 * 60 * 1000 } })
  async preview(@Param('token') token: string, @Req() req: FastifyRequest) {
    const audit = extractAudit(req);
    const data = await this.publicSign.preview(token, audit);
    return { data };
  }

  /**
   * C2 (Gate-6) — GET /sign/:token/document — token-scoped decrypt-STREAM of a
   * SENSITIVE document's PLAINTEXT. The preview returns THIS URL (instead of a
   * raw R2 presign) for sensitive+encrypted docs so national_id / נסח PII is
   * never served unencrypted to the unauthenticated signer. The service runs the
   * full token gate chain and serves ONLY sensitive+encrypted docs (everything
   * else → generic 401 invalid_token). Forced attachment + nosniff, mirroring
   * the authenticated document download.
   */
  @Get(':token/document')
  @Throttle({ default: { limit: 30, ttl: 60 * 60 * 1000 } })
  async previewDocument(
    @Param('token') token: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const audit = extractAudit(req);
    const result = await this.publicSign.previewDocumentStream(token, audit);
    const disp =
      `attachment; filename="${safeDownloadFilename(result.name)}"` +
      `; filename*=UTF-8''${encodeURIComponent(result.name)}`;
    return reply
      .header('content-type', result.mimeType)
      .header('content-disposition', disp)
      .header('content-length', String(result.sizeBytes))
      .header('x-content-type-options', 'nosniff')
      .send(result.stream);
  }

  @Post(':token')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  async sign(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(PublicSignSubmitInput)) body: PublicSignSubmit,
    @Req() req: FastifyRequest,
  ) {
    const audit = extractAudit(req);
    const data = await this.publicSign.sign(token, body, audit);
    return { data };
  }
}

/** Pull IP + UA from the request. Fastify's `.ip` is trustProxy-aware
 *  (configured in main.ts), so reverse-proxy `X-Forwarded-For` is
 *  honoured when the proxy chain is trusted. UA is whatever the
 *  browser sent; we cap it to a sane length to prevent log bloat. */
function extractAudit(req: FastifyRequest): {
  ip: string | undefined;
  userAgent: string | undefined;
} {
  const ip = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : undefined;
  const ua = req.headers['user-agent'];
  const userAgent = typeof ua === 'string' && ua.length > 0 ? ua.slice(0, 500) : undefined;
  return { ip, userAgent };
}

// Sanity export so the lint allow-list catches accidental imports.
export { PUBLIC_SIGN_SVG_MAX_BYTES };
