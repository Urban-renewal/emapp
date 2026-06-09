import type { BreachDetectionService, IMetricsProvider } from '@emapp/db';
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

import { BREACH_DETECTION, METRICS_PROVIDER } from './observability.tokens';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_NUM_RE = /\/\d+(?=\/|$)/g;

/**
 * Collapse a concrete request path to a LOW-CARDINALITY route label so the
 * `route` metric label can never explode (one series per id) or carry an id
 * that could re-identify a subject. Strips the query string, then replaces
 * UUID segments and long numeric segments with `:id`. The Fastify route
 * template (`req.routeOptions.url`) is preferred when present because it is
 * already templated (`/api/v1/owners/:id`); this is the fallback.
 */
export function routeLabel(req: FastifyRequest): string {
  const tmpl = (req as { routeOptions?: { url?: string } }).routeOptions?.url;
  if (typeof tmpl === 'string' && tmpl.length > 0) return tmpl;
  const path = (req.url ?? '').split('?')[0] ?? '';
  return path.replace(UUID_RE, ':id').replace(LONG_NUM_RE, '/:id') || '/';
}

function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return '1xx';
}

/**
 * P0.B2 — request count + latency at the existing request seam (the
 * `TODO(metrics)` hook generalised). Emits two metrics with low-cardinality,
 * NON-PII labels only:
 *   - `http_requests_total{method, route, status_class}`
 *   - `http_request_duration_ms{method, route}` (histogram)
 *
 * It also drives the breach detector's authz-denial signal: a 403 response on
 * an AUTHENTICATED actor (the guard rejected them) is observed per-actor, so a
 * burst of denials (a compromised/over-probing session) trips an alert. This
 * is the clean DI seam for that signal — the AuthorizationGuard is zero-DI by
 * contract (`new AuthorizationGuard()` per controller) and the exception filter
 * is a pure `@Catch()` class, so neither can hold the injected detector; the
 * global interceptor can, and it sees both the actor and the final status.
 *
 * FAIL-OPEN: every emit is inside the provider (which swallows its own
 * errors) and we never await it — a metrics fault can never break a request.
 * Mirrors the global-interceptor pattern already used by IdempotencyInterceptor.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(
    @Inject(METRICS_PROVIDER) private readonly metrics: IMetricsProvider,
    @Inject(BREACH_DETECTION) private readonly breach: BreachDetectionService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Only HTTP requests carry the labels we emit; skip anything else cheaply.
    if (ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: { sub?: string } }>();
    const res = ctx.switchToHttp().getResponse<FastifyReply>();
    const start = Date.now();
    const method = req.method ?? 'UNKNOWN';

    const record = (statusOverride?: number): void => {
      const route = routeLabel(req);
      const status = statusOverride ?? res.statusCode ?? 0;
      this.metrics.counter('http_requests_total', 1, {
        method,
        route,
        status_class: statusClass(status),
      });
      this.metrics.timing('http_request_duration_ms', Date.now() - start, { method, route });

      // Authz-denial breach signal: a 403 on an authenticated actor only.
      // (401/unauthenticated is not an authz-denial; no actor id to scope by,
      // and it's already covered by the auth-failure signal.) Actor id is an
      // opaque UUID — no PII.
      if (status === 403 && req.user?.sub) {
        this.breach.observeAuthzDenial(req.user.sub);
      }
    };

    return next.handle().pipe(
      tap({
        next: () => record(),
        // On error the exception filter sets the response status AFTER this
        // interceptor, so read the status off the thrown HttpException instead
        // (a guard's ForbiddenException carries 403). The error still
        // propagates normally — recording is side-effect only.
        error: (err: unknown) => {
          const thrown =
            (err as { status?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
          record(typeof thrown === 'number' ? thrown : 500);
        },
      }),
    );
  }
}
