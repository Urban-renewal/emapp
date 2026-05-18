import './instrument';
import { serverEnv as env } from '@emapp/config';
import { verifyEncryptionStartup } from '@emapp/db';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

const CORS_ORIGINS = {
  production: ['https://app.emapp.io'],
  preview: [/^https:\/\/[\w-]+\.emapp\.pages\.dev$/],
  development: ['http://localhost:3001', 'http://127.0.0.1:3001'],
  test: [] as string[],
} as const;

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
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
      const e = new Error('Invalid JSON') as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e);
    }
  });

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
        connectSrc: ["'self'", 'https://*.sentry.io', 'https://api.resend.com'],
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
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Reason'],
    maxAge: 86400,
  });

  app.enableShutdownHooks();

  // P1.10: fail fast if PII encryption/HMAC keys are missing or invalid,
  // BEFORE serving any request. Skipped only in the no-accounts local path.
  if (!process.env['SKIP_ENV_VALIDATION']) {
    await verifyEncryptionStartup();
  }

  const port = env.PORT_API ?? 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});
