import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { HealthController } from './app.controller';
import { ConfigurableThrottlerGuard } from './common/guards/throttler.guard';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { ApartmentsModule } from './modules/apartments/apartments.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BuildingsModule } from './modules/buildings/buildings.module';
import { ContractorsModule } from './modules/contractors/contractors.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ImportsModule } from './modules/imports/imports.module';
import { MembersModule } from './modules/members/members.module';
import { NotesModule } from './modules/notes/notes.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OwnersModule } from './modules/owners/owners.module';
import { OwnershipsModule } from './modules/ownerships/ownerships.module';
import { PortalModule } from './modules/portal/portal.module';
import { ProjectAssignmentsModule } from './modules/project-assignments/project-assignments.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProviderModule } from './modules/provider/provider.module';
import { SharesModule } from './modules/shares/shares.module';
import { SignaturesModule } from './modules/signatures/signatures.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    LoggerModule.forRoot({
      pinoHttp: {
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.token',
            // PII — owner create/update/search bodies (Doc07: never log PII).
            'req.body.national_id',
            'req.body.phone',
            // Phase 5 (docs/03 §9): signing token NEVER in logs, not even
            // partial. The token is the credential — same posture as a
            // password. The :token path param is redacted via the URL
            // censor below.
            'req.params.token',
            // SVG signature payload is encrypted at rest (D.12 LAW); also
            // keep it out of request logs.
            'req.body.signatureSvg',
          ],
          // Path-level redaction for the URL itself — Pino doesn't have
          // a built-in regex censor, so we set a censor function that
          // replaces /sign/<token>... with /sign/[REDACTED] across
          // log fields containing the URL. The leaf redactions above
          // cover the structured request; this covers any embedded URL.
          censor: (value: unknown): unknown => {
            if (typeof value === 'string' && /\/sign\/[\w-]+\.[\w-]+\.[\w-]+/.test(value)) {
              return value.replace(/\/sign\/[\w-]+\.[\w-]+\.[\w-]+/g, '/sign/[REDACTED]');
            }
            return '[REDACTED]';
          },
        },
        level: process.env['NODE_ENV'] !== 'production' ? 'debug' : 'info',
      },
    }),
    AuthModule,
    ProjectsModule,
    BuildingsModule,
    ApartmentsModule,
    OwnersModule,
    OwnershipsModule,
    ContractorsModule,
    DocumentsModule,
    SharesModule,
    TasksModule,
    NotificationsModule,
    NotesModule,
    AuditModule,
    ProjectAssignmentsModule,
    MembersModule,
    SignaturesModule,
    QueueModule,
    ImportsModule,
    // D.37 — Phase 6.5 Provider Admin BE (read-only). Tier-isolated:
    // ProviderAuthGuard rejects org JWTs structurally (audience
    // mismatch per D.29). NO write endpoints — Gate-6 deferred.
    ProviderModule,
    // D.40 — V11 Tenant Portal own-data view (read-only). Tier-
    // isolated: TenantAuthGuard rejects org/provider JWTs via
    // audience mismatch (`emapp-tenant` per D.29). No write
    // endpoints. POLICY untouched — portal has no entry in the
    // org POLICY matrix (Gate-6 untouched).
    PortalModule,
  ],
  controllers: [HealthController],
  // Rate limiting ENFORCED globally; the configurable guard adds a
  // prod-safe, env-gated per-request bypass for the conformance suite.
  providers: [
    { provide: APP_GUARD, useClass: ConfigurableThrottlerGuard },
    // Optional-but-honoured Idempotency-Key on mutating POSTs (D.16-safe
    // replay, concurrency-correct). Global; no-ops unless the header is
    // present on a non-auth POST.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
