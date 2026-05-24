/**
 * D.37 / Phase 6.5 — `access_reason` HTTP header param decorator.
 *
 * Every `/api/v1/provider/*` endpoint requires the `access_reason`
 * header. Missing or too-short → `400 reason_required`. The header is
 * the human-readable reason that lands in `provider_audit_log.reason`
 * (and `metadata.reason` per the v8.5-fixed `withProvider`).
 *
 * Why header instead of body:
 *   - Browser DevTools / fetch dev tools surface a header at every
 *     request review; a body field gets buried.
 *   - Read-only GETs (the entire Phase 6.5 surface) MUST NOT carry a
 *     body — REST + intermediary cache behaviour. Header is the only
 *     correct place.
 *   - Header survives Cloudflare WAF rewrites; body parsing varies.
 *
 * Length bounds:
 *   - min 5 chars: enough to prevent accidental empty/typos
 *     ("test", "" → rejected); enforces the same minimum
 *     withProvider itself checks server-side as defense-in-depth.
 *   - max 512 chars: prevents log-bloat / accidental dumps. The
 *     Fastify header limit is ~8KB anyway; 512 is what we record.
 */
import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export const ACCESS_REASON_HEADER = 'access_reason' as const;
const MIN_LEN = 5;
const MAX_LEN = 512;

export const AccessReason = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    // Fastify lowercases header names. The header name is itself
    // intentionally snake_case (mirrors `app.access_reason` GUC + the
    // audit row column) — readability over HTTP convention.
    const raw = req.headers[ACCESS_REASON_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException({
        error: {
          code: 'reason_required',
          message: `Header "${ACCESS_REASON_HEADER}" is required on every /provider/* call`,
        },
      });
    }
    const trimmed = value.trim();
    if (trimmed.length < MIN_LEN) {
      throw new BadRequestException({
        error: {
          code: 'reason_required',
          message: `Header "${ACCESS_REASON_HEADER}" must be at least ${MIN_LEN} characters`,
        },
      });
    }
    if (trimmed.length > MAX_LEN) {
      // Truncate-at-the-edge would silently lose forensic context;
      // explicit rejection forces the caller to summarise.
      throw new BadRequestException({
        error: {
          code: 'reason_required',
          message: `Header "${ACCESS_REASON_HEADER}" must be at most ${MAX_LEN} characters`,
        },
      });
    }
    return trimmed;
  },
);
