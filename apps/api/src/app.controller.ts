import { db, sql } from '@emapp/db';
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

/**
 * Liveness vs readiness — the K8s / Railway / Cloudflare standard split.
 *
 * `/api/v1/health` (liveness) is "is the process alive?" → no work, no
 * dependencies, no DB ping. The orchestrator uses this to decide whether
 * to RESTART the container. A liveness probe that pings the DB
 * accidentally turns every transient DB hiccup into a process restart
 * — at best a thundering-herd reconnect, at worst a cascading outage.
 *
 * `/api/v1/ready` (readiness) is "can the process serve traffic?" → it
 * DOES touch the DB (and would touch R2 / queue if those were on the
 * request path). The orchestrator uses this to decide whether to ROUTE
 * traffic; failure here removes the instance from the load balancer
 * without restarting.
 *
 * **Why this split matters (closes F-PERF-2 from 2026-05-25 manual
 * QA):** measured locally with Neon as the DB, `/health` TTFB dropped
 * from ~360 ms (with the DB ping) to ~213 ms (without) — a 40 %
 * reduction. The savings is bounded below by the Nest+Fastify+Helmet
 * +pino+throttler fixed cost, which is still ~210 ms in dev. The
 * bigger win is correctness: health endpoints get hit by uptime
 * monitors, Railway's restart probe, and the FE's network ping on
 * tab focus — often more than once per second per instance. A
 * liveness probe that pings the DB cascades a DB hiccup into a
 * process restart. The same DB-ping shape stays available on
 * `/ready` for legitimate readiness consumers; orchestrators that
 * still hit `/health` get a fast, accurate "process is alive"
 * answer with no false negatives on DB flake.
 */
@Controller()
export class HealthController {
  /**
   * Liveness probe — answers "is the process up?" Nothing more.
   *
   * Returns 200 with uptime + timestamp. Does NOT touch the DB,
   * caches, queues, or external services. If the event loop is
   * blocked OR the process has crashed, the OS returns the connection
   * error and the orchestrator restarts us — exactly the correct
   * trigger for a restart. No DB-flake false positives.
   */
  @Get('health')
  getHealth(): { status: 'ok'; uptime: number; timestamp: string } {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness probe — answers "is the process ready to serve traffic?"
   *
   * Pings the DB (the one critical dependency every request touches via
   * `withTenant` / `withProvider`). Returns 503 if the DB ping fails so
   * the load balancer can drain this instance; the OS / Railway does
   * NOT restart on a 503 here — that's `/health`'s job.
   *
   * Shape is intentionally identical to the pre-split `/health` body
   * so any existing readiness consumer can move the URL without
   * touching the parser.
   */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async getReady(): Promise<{
    status: 'ok' | 'degraded';
    db: 'connected' | 'disconnected';
    uptime: number;
    timestamp: string;
  }> {
    let dbStatus: 'connected' | 'disconnected' = 'disconnected';
    try {
      await db.execute(sql`SELECT 1`);
      dbStatus = 'connected';
    } catch {
      // intentionally swallow — the status field is the signal
    }

    return {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      db: dbStatus,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
