import './instrument';
import { serverEnv as env } from '@emapp/config';
import { reloadEnv, verifyEncryptionStartup, verifyProviderPoolRole } from '@emapp/db';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { assertDevBypassNotInProduction } from './common/dev-auth-bypass';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { resetStorageProvider } from './modules/documents/storage';
import { installProcessGuards } from './process-guards';

const CORS_ORIGINS = {
  production: ['https://app.emapp.io'],
  preview: [/^https:\/\/[\w-]+\.emapp\.pages\.dev$/],
  development: ['http://localhost:3001', 'http://127.0.0.1:3001'],
  // 'test' is the conformance CI env (ci.yml NODE_ENV=test). The contract
  // suite is Node-side fetch (no Origin) so this used to not matter — but
  // DD11 explicitly sends an Origin to verify the CORS preflight (A1
  // audit-fix). Allow the dev origin in test too so that browser-shaped
  // preflight tests work in CI. Benign — test env never reaches users.
  test: ['http://localhost:3001', 'http://127.0.0.1:3001'],
} as const;

async function bootstrap() {
  // Fail-fast (defense-in-depth): never boot with the dev auth bypass enabled
  // in production, even if the gate would already keep it dormant.
  assertDevBypassNotInProduction();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Audit v1.1 CC-1 (ISO A.12.4.1) — `trustProxy: true` honoured ANY
      // `X-Forwarded-For`, so a caller could spoof the IP recorded in
      // `provider_audit_log.ip` (the single forensic "where" attribution
      // for cross-tenant access). Trust exactly ONE hop — the immediate
      // upstream proxy. Railway + Cloudflare each add a single hop; the
      // real client IP lands in `X-Forwarded-For[0]` and Fastify pulls
      // it correctly with `trustProxy: 1`. Any future ingress change
      // (extra hop, direct-Railway URL) should re-verify this number
      // before merging.
      //
      // Note: an explicit CIDR list (`trustProxy: ['<railway-cidr>', ...]`)
      // would be even stronger but requires tracking Railway's edge CIDRs
      // which change. `1` is the conservative choice that defends the
      // most likely attack (header forgery from a single attacker).
      trustProxy: 1,
      // Phase 5 (docs/03 §9): the public-link signing flow puts a JWT in
      // the path (`/sign/:token`). HS256 JWTs with our claim shape are
      // ~600-800 chars; Fastify's default maxParamLength is 100, which
      // would silently 404 every real signing link. 1500 is generous
      // headroom for any future claim additions.
      maxParamLength: 1500,
    }),
    // bodyParser:false — Nest must NOT register its own application/json
    // parser (it runs during listen() and collides with ours). We register
    // a single JSON parser below that also tolerates an empty body.
    { bufferLogs: true, bodyParser: false },
  );

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Cookie-only POSTs (auth/refresh, auth/logout) legitimately carry no body.
  // Fastify's default JSON parser 400s on an empty body even when the client
  // sends Content-Type: application/json (our api-client sets it on every
  // request). Treat an empty json body as {} so those endpoints reach the
  // handler (and return their proper 401, not a framework 400).
  const fastify = app.getHttpAdapter().getInstance() as unknown as {
    removeContentTypeParser?: (t: string) => void;
    addContentTypeParser: (
      t: string,
      o: { parseAs: 'string' },
      h: (req: unknown, body: string, done: (e: Error | null, v?: unknown) => void) => void,
    ) => void;
  };
  // Replace Fastify's built-in JSON parser (which 400s on empty body).
  try {
    fastify.removeContentTypeParser?.('application/json');
  } catch {
    /* not present — fine */
  }
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || body.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      // Self-describe with a STABLE discriminator (code) + status so the
      // exception filter never has to string-match the message.
      const e = new Error('Invalid JSON') as Error & {
        statusCode?: number;
        code?: string;
      };
      e.statusCode = 400;
      e.code = 'invalid_json';
      done(e);
    }
  });

  // §M-1 — 404 envelope normalization happens in GlobalExceptionFilter
  // (see common/filters/http-exception.filter.ts). NestJS+Fastify will
  // throw a NotFoundException for unmatched routes; the filter rewrites
  // it to the D.16 `{error:{code:'not_found'}}` envelope.
  //
  // Why not Fastify's `setNotFoundHandler` directly: NestJS's
  // RoutesResolver.registerNotFoundHandler ALSO calls setNotFoundHandler
  // during app.listen() initialization, and Fastify allows only ONE
  // handler — collisions throw "Not found handler already set for
  // Fastify instance with prefix: '/'". Routing through the filter is
  // the only approach compatible with NestJS+Fastify.

  // D.10: every endpoint under /api/v1/
  app.setGlobalPrefix('api/v1');

  // Cookies are NOT signed (we never use signed:true — auth value is a
  // self-signed JWT / hashed-at-rest refresh token). No cookie secret is
  // needed; passing the retired Better-Auth secret here was dead, confusing
  // surface post-D.21 and a rotation foot-gun.
  await app.register(cookie);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'https://*.r2.cloudflarestorage.com', 'data:'],
        connectSrc: [
          "'self'",
          'https://*.sentry.io',
          'https://api.resend.com',
          // A2 audit-fix (2026-05-20): FE direct PUT/GET to R2 presigned
          // URLs (docs/03 §8) needs R2 in connect-src or browsers block
          // every upload/download. imgSrc already lists R2; this matches.
          'https://*.r2.cloudflarestorage.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    crossOriginEmbedderPolicy: false,
  });

  const nodeEnv = env.NODE_ENV as keyof typeof CORS_ORIGINS;
  const allowedOrigins: (string | RegExp)[] = [
    ...(CORS_ORIGINS[nodeEnv] ?? []),
    ...(nodeEnv === 'production' ? CORS_ORIGINS.preview : []),
  ];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = allowedOrigins.some((entry) =>
        entry instanceof RegExp ? entry.test(origin) : entry === origin,
      );
      callback(allowed ? null : new Error(`CORS: origin ${origin} not allowed`), allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // A1 audit-fix (2026-05-20): Idempotency-Key must be in the preflight
    // allow-list or browsers silently block every mutating POST that sets
    // it (Phase 3 hardening contract). Server-side tests pass without it
    // (no preflight); real browsers would 0-request the endpoint.
    // Audit v1.1 SA-15 — `access_reason` (D.37 mandatory header on every
    // /provider/* call) was missing from the CORS allowlist. A FE on a
    // different origin would see preflight strip it and the BE would
    // 400 `reason_required`. `X-Reason` is kept for back-compat but is
    // not the live header name. Folded into one allowlist; future
    // headers should be added here in alphabetical order.
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Reason',
      'access_reason',
    ],
    maxAge: 86400,
  });

  app.enableShutdownHooks();

  // Process-level safety net (from rebased PR #18 → new PR).
  // - unhandledRejection: log + Sentry, survive (a stray fire-and-forget
  //   promise can no longer crash the API).
  // - uncaughtException: log + Sentry; exit(1) on unknown codes
  //   (Railway restarts cleanly). EPIPE / ECONNRESET log-only.
  // - SIGTERM / SIGINT: graceful drain — app.close() → closeAllPools()
  //   → exit(0). Required for Railway zero-downtime deploys.
  // The handler is idempotent w.r.t. Nest's enableShutdownHooks() above:
  // both register SIGTERM/SIGINT listeners; app.close() is idempotent
  // and closeAllPools() swallows duplicate-.end() errors.
  installProcessGuards({ app });

  // P1.10: fail fast if PII encryption/HMAC keys are missing or invalid,
  // BEFORE serving any request. Skipped only in the no-accounts local path.
  if (!process.env['SKIP_ENV_VALIDATION']) {
    await verifyEncryptionStartup();
    // Audit v1.1 SA-1 — also verify the Provider pool is connected as
    // a BYPASSRLS role (and that PROVIDER_DATABASE_URL is set in
    // production). Skipped automatically in test/test-DB scenarios.
    await verifyProviderPoolRole();
  }

  // v8 §v7-C — SIGHUP credential reload. Ops sequence to rotate R2 keys
  // (or any other env-driven secret) without a process restart:
  //   1. Update Infisical → push to running process env (Railway hot-update
  //      / kubectl set env, or external secret-manager push).
  //   2. `kill -HUP <api-pid>` (Railway: send the SIGHUP via their CLI;
  //      most orchestrators have a built-in "reload" verb).
  //   3. This handler re-reads process.env, drops the cached S3Client,
  //      and the next /imports call mints with the new credentials.
  // Pre-rotation: no in-flight presign uses the stale creds (the
  // process MAY have one in-flight call mid-await; that's accepted
  // — the rotation window is sub-second).
  process.on('SIGHUP', () => {
    try {
      const changed = reloadEnv();
      resetStorageProvider();
      // pino isn't injected at this scope; bare console for the SIGHUP
      // event (one-off, audit-by-supervisor-record). We log only the
      // KEYS, never the values.
      // eslint-disable-next-line no-console
      console.warn(
        `[SIGHUP] env reloaded; changed keys: ${changed.length === 0 ? '(none)' : changed.join(',')}; storage provider singleton dropped`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[SIGHUP] reload failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  });

  const port = env.PORT_API ?? 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});
