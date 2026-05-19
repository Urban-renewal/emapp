import { createHash } from 'node:crypto';

import {
  idempotencyClaim,
  idempotencyComplete,
  idempotencyPeek,
  idempotencyRelease,
} from '@emapp/db';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

import type { AccessTokenPayload } from '../../modules/auth/auth.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * OPTIONAL but honoured (Stripe-style, per the recorded decision; docs/09
 * §3.10 specifies the header — enforcing it as REQUIRED would break every
 * existing client + the 159-clause conformance suite, so it is opt-in per
 * request). When a client sends `Idempotency-Key` on a mutating POST, a
 * network retry / double-submit performs the work ONCE and replays the
 * original {status, body}. Concurrency-correct via an atomic claim.
 *
 * Scope: POST only, excluding auth/provider paths (never cache auth) and
 * the GET-like POSTs (search/read) are harmless to replay anyway.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AccessTokenPayload }>();
    const res = ctx.switchToHttp().getResponse<FastifyReply>();

    if (req.method !== 'POST') return next.handle();
    const hdr = req.headers['idempotency-key'];
    const idemKey = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!idemKey) return next.handle(); // optional — absent ⇒ normal flow

    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path.startsWith('/api/v1/auth') || path.startsWith('/api/v1/provider')) {
      return next.handle(); // never idempotency-cache auth flows
    }
    if (!UUID.test(idemKey)) {
      throw new BadRequestException({
        error: { code: 'validation_error', details: { 'idempotency-key': ['must be a uuid'] } },
      });
    }

    // Key is scoped to org + user + exact route so one client's key can
    // never replay another's response or cross endpoints.
    const orgId = req.user?.orgId ?? 'anon';
    const userId = req.user?.sub ?? 'anon';
    const material = `${orgId}:${userId}:POST:${path}:${idemKey}`;
    const key = 'idem:' + createHash('sha256').update(material).digest('hex');

    const claimed = await idempotencyClaim(key);
    if (!claimed) {
      const rec = await idempotencyPeek(key);
      if (rec?.state === 'done') {
        res.status(rec.status ?? 200);
        return of(rec.body);
      }
      // Same key still in flight → the duplicate must not double-execute.
      throw new ConflictException({ error: { code: 'idempotency_conflict' } });
    }

    return next.handle().pipe(
      tap((body) => {
        // statusCode is finalised by the time the handler emits.
        void idempotencyComplete(key, res.statusCode ?? 201, body);
      }),
      catchError((err: unknown) => {
        // A failed op must be retryable — free the claim, propagate.
        void idempotencyRelease(key);
        throw err;
      }),
    );
  }
}
