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

// D.37 hardening — strip control characters from the header value
// BEFORE length/content checks. Order matters: a value like
// `"   \r\n   "` looks valid pre-strip (length 9, trim is empty); we
// must strip → trim → check, not trim → check (which would let
// embedded `\r\n` poison the audit row).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/g;

function bail(reason: string): never {
  throw new BadRequestException({
    error: {
      code: 'reason_required',
      message: reason,
    },
  });
}

/**
 * Pure parsing/validation function — exported for unit testing.
 * The createParamDecorator wrapper below is a thin shim that pulls
 * the header out of the Fastify request and forwards to this.
 * Keeps the validation logic testable without a Nest runtime.
 */
export function parseAccessReasonHeader(rawHeader: string | string[] | undefined): string {
  // A header sent twice arrives as string[]; defense — refuse
  // ambiguity rather than guess which value to audit.
  if (Array.isArray(rawHeader)) {
    bail(`Header "${ACCESS_REASON_HEADER}" must appear at most once per request`);
  }
  if (typeof rawHeader !== 'string' || rawHeader.length === 0) {
    bail(`Header "${ACCESS_REASON_HEADER}" is required on every /provider/* call`);
  }
  // Strip control chars FIRST, then trim. Order matters: a value of
  // `"   \r\n   "` (length 9) looks valid pre-strip but cleans to "".
  const cleaned = rawHeader.replace(CONTROL_CHARS_REGEX, '').trim();
  if (cleaned.length < MIN_LEN) {
    bail(
      `Header "${ACCESS_REASON_HEADER}" must be at least ${MIN_LEN} characters after control-char strip`,
    );
  }
  if (cleaned.length > MAX_LEN) {
    // Truncate-at-the-edge would silently lose forensic context;
    // explicit rejection forces the caller to summarise.
    bail(`Header "${ACCESS_REASON_HEADER}" must be at most ${MAX_LEN} characters`);
  }
  return cleaned;
}

export const AccessReason = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    // Fastify lowercases header names. The header name is itself
    // intentionally snake_case (mirrors `app.access_reason` GUC + the
    // audit row column) — readability over HTTP convention.
    return parseAccessReasonHeader(req.headers[ACCESS_REASON_HEADER]);
  },
);
