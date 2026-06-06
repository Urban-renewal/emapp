/**
 * **Audit v1.1 SA-6 (HIGH, ISO A.12.4.1) closure.**
 *
 * Pre-closure: Zod validation + `decodeCursor` fail-fast BEFORE
 * `withProvider` is entered, so rejected/probed/fuzzed Provider calls
 * wrote ZERO rows to `provider_audit_log`. A compromised Provider
 * Admin could probe the surface for hours without leaving any
 * forensic trace on the privileged-tier audit table.
 *
 * Closure shape: write a `provider.request.received` audit row IN AN
 * AUTONOMOUS TRANSACTION (the SA-7 closure already gives this for
 * free via `withProvider`) BEFORE the Zod pipe + handler run. If
 * validation rejects, the row stays committed. If the handler then
 * writes its own per-action row (`provider.tenant.viewed` etc.), the
 * two rows correlate by ip + user-agent + same provider_user_id + a
 * close `started_at` timestamp — sufficient for a forensic walk
 * without introducing a new `request_id` column.
 *
 * Why an interceptor (not a Nest pipe / middleware):
 *   - Pipes run AFTER guards but they run per @-decorator (one pipe
 *     per `@Query` etc.) — too granular and order-sensitive for an
 *     audit obligation that must fire EXACTLY ONCE per authenticated
 *     request.
 *   - Middleware runs before guards (auth not yet verified) and has
 *     no clean access to ExecutionContext metadata.
 *   - Interceptors run AFTER all guards (so `req.providerUser` is
 *     populated by `ProviderAuthGuard`) and BEFORE the handler — the
 *     exact window we want.
 *
 * Order with other interceptors / guards (Nest semantics):
 *   1. ProviderAuthGuard (JWT)
 *   2. ProviderAuthorizationGuard (PROVIDER_POLICY matrix)
 *   3. **ProviderRequestAuditInterceptor (this file)** ← writes audit
 *   4. ZodValidationPipe (per @Query / @Body decorator)
 *   5. Handler
 *
 * Failure mode: if the autonomous audit INSERT itself fails (DB
 * outage, table missing), the interceptor rejects with 500. We do
 * NOT silently let the request through — the audit obligation is
 * structural; serving a request that we can't audit is a bigger
 * compliance risk than a transient 500.
 */
import { withProvider } from '@emapp/db';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import type { ProviderTokenPayload } from '../auth/provider/provider-auth.service';

const REQUEST_AUDIT_ACTION = 'provider.request.received';
// A neutral, always-acceptable reason value used as the auto-reason
// when the caller has not yet validated their access_reason header.
// `validateProviderReason` enforces a quality bar; this string both
// passes the bar (a recognised ticket-style prefix) AND is
// distinguishable in audit reports (Ops can grep `auto:` to find
// system-injected reasons vs human-entered ones).
const SYSTEM_REASON_FALLBACK = 'auto: provider request received (pre-validation audit)';

/**
 * L1 — scrub query-param VALUES from a URL before it lands in the
 * provider_audit_log. The PATH (incl. UUID path-params — not PII) and the
 * query-param KEYS are kept (forensic "which filter/cursor was probed"), but
 * every VALUE is redacted so a future provider endpoint that accepts PII in a
 * query param can never leak it into the audit trail. No provider endpoint
 * takes PII in a query string today; this is defense-in-depth.
 */
export function scrubUrlForAudit(url: string): string {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;
  const path = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  if (query.length === 0) return path;
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? pair : `${pair.slice(0, eq)}=[redacted]`;
    })
    .join('&');
  return `${path}?${redacted}`;
}

@Injectable()
export class ProviderRequestAuditInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { providerUser?: ProviderTokenPayload }>();

    // ProviderAuthGuard runs upstream and populates `providerUser`;
    // if it's missing, the request never should have reached this
    // interceptor. Defence-in-depth: bail through without an audit
    // row (the missing-auth case is its own 401 path).
    const payload = req.providerUser;
    if (!payload?.sub) {
      return next.handle();
    }

    // Try to use the caller's access_reason header IF it's present
    // and quality-passing. Otherwise fall back to the system reason
    // (Ops can grep / report on auto-reasons separately).
    const rawHeader = req.headers['access_reason'];
    const headerStr = typeof rawHeader === 'string' && rawHeader.length > 0 ? rawHeader : undefined;

    const ua = req.headers['user-agent'];
    const userAgent = typeof ua === 'string' ? ua.slice(0, 512) : undefined;

    // Write the autonomous audit row, THEN let the request proceed.
    // `withProvider` commits the row in its own tx (SA-7 closure)
    // before the callback runs, so even if `next.handle()` throws
    // synchronously the row is permanent.
    const auditPromise = withProvider(
      payload.sub,
      headerStr ?? SYSTEM_REASON_FALLBACK,
      async () => undefined,
      {
        ip: req.ip,
        userAgent,
        action: REQUEST_AUDIT_ACTION,
        targetTable: null as unknown as string | undefined,
        metadata: {
          method: req.method,
          // Path + query-param KEYS (which filter / cursor was probed); query
          // VALUES are redacted (L1) so a future PII-in-query-param endpoint
          // can't leak into the audit row. Length bounded by maxParamLength.
          url: scrubUrlForAudit(req.url),
          // Was the caller-supplied access_reason present + non-empty?
          // Helps Ops distinguish "no header at all" (likely scanner)
          // from "low-quality header" (likely human).
          callerReasonPresent: headerStr !== undefined,
        },
      },
    ).catch((e: unknown) => {
      // If the access_reason was provided but failed the v1.1 quality
      // bar (or any other validator failed inside withProvider), the
      // user is going to get a 400 from the ZodValidationPipe anyway
      // — we don't want the audit INSERT to crash with a confusing
      // 500 in that path. Re-try with the system fallback reason so
      // the audit row still lands. The original validation error
      // surfaces normally via the handler chain.
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes('reason_required') ||
        msg.includes('reason_too_long') ||
        msg.includes('reason_low_quality')
      ) {
        return withProvider(payload.sub, SYSTEM_REASON_FALLBACK, async () => undefined, {
          ip: req.ip,
          userAgent,
          action: REQUEST_AUDIT_ACTION,
          metadata: {
            method: req.method,
            url: scrubUrlForAudit(req.url),
            callerReasonPresent: headerStr !== undefined,
            callerReasonRejected: true,
          },
        });
      }
      // Any OTHER failure (DB outage, table missing, role probe
      // failed) is a real compliance problem — re-raise so the
      // request fails loud rather than being silently un-audited.
      throw e;
    });

    return from(auditPromise).pipe(switchMap(() => next.handle()));
  }
}
