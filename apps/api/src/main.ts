import './instrument';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { Logger } from 'nestjs-pino';
import { serverEnv as env } from '@emapp/config';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

const CORS_ORIGINS = {
  production: [
    'https://app.emapp.io',
  ],
  preview: [
    /^https:\/\/[\w-]+\.emapp\.pages\.dev$/,
  ],
  development: [
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ],
  test: [] as string[],
} as const;

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GlobalExceptionFilter());

  // D.10: every endpoint under /api/v1/
  app.setGlobalPrefix('api/v1');

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

  const port = env.PORT_API ?? 3000;
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});
