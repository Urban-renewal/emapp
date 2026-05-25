/**
 * D.37 / Phase 6.5 — `access_reason` HTTP header decorator.
 *
 * Every `/api/v1/provider/*` call must carry an `access_reason` header
 * (snake_case, mirrors `app.access_reason` GUC + the audit_log column).
 * Missing / too-short / too-long / low-quality → 400 with one of:
 *   `reason_required` | `reason_too_long` | `reason_low_quality`.
 *
 * **Audit v1.1 closures (CC-2 + CC-3 + SA-13).** The validation logic
 * (length floor, control-char strip, ticket-pattern / substantive-text
 * quality rule) lives in `@emapp/shared-types/provider-validators` so
 * the decorator and the `withProvider` wrapper share ONE source of
 * truth. Before the closure, the rules were duplicated across two
 * files and the constants had begun to drift. This file is now a thin
 * HTTP shim.
 *
 * The CC-2 quality bar: a recognised ticket reference (e.g.
 * `INC-1234`, `SUP-9912: investigating timeout`) passes immediately;
 * otherwise the reason must be ≥20 chars, ≥3 tokens, and ≥4 distinct
 * characters. Defeats the `"aaaaa"` / `"test1"` / `"....."` checkbox
 * pattern that ISO 27001 A.9.4.1 auditors flag.
 *
 * Why header instead of body:
 *   - Browser DevTools / fetch dev tools surface a header at every
 *     request review; a body field gets buried.
 *   - Read-only GETs (the entire Phase 6.5 surface) MUST NOT carry a
 *     body — REST + intermediary cache behaviour. Header is the only
 *     correct place.
 *   - Header survives Cloudflare WAF rewrites; body parsing varies.
 */
import { validateProviderReason } from '@emapp/db';
import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export const ACCESS_REASON_HEADER = 'access_reason' as const;

/**
 * Pure parsing/validation function — exported for unit testing.
 * Throws `BadRequestException` with a stable error code from
 * `validateProviderReason`. The createParamDecorator wrapper below is
 * a thin shim that pulls the header out of the Fastify request and
 * forwards to this.
 */
export function parseAccessReasonHeader(rawHeader: string | string[] | undefined): string {
  // A header sent twice arrives as `string[]`; defence — refuse
  // ambiguity rather than guess which value to audit.
  if (Array.isArray(rawHeader)) {
    throw new BadRequestException({
      error: {
        code: 'reason_required',
        message: `Header "${ACCESS_REASON_HEADER}" must appear at most once per request`,
      },
    });
  }
  const result = validateProviderReason(rawHeader);
  if (!result.ok) {
    throw new BadRequestException({
      error: {
        // Stable codes: 'reason_required' | 'reason_too_long' | 'reason_low_quality'
        code: result.code,
        message: result.detail,
      },
    });
  }
  return result.value;
}

export const AccessReason = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    // Fastify lowercases header names. The header name is intentionally
    // snake_case (mirrors `app.access_reason` GUC + the audit row
    // column) — readability over HTTP convention.
    return parseAccessReasonHeader(req.headers[ACCESS_REASON_HEADER]);
  },
);
