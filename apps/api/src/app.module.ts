import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { HealthController } from './app.controller';
import { ConfigurableThrottlerGuard } from './common/guards/throttler.guard';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { GlobalZodValidationPipe } from './common/pipes/global-zod-validation.pipe';
import { LOG_REDACT } from './logging/log-redact';
import { ApartmentsModule } from './modules/apartments/apartments.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BuildingsModule } from './modules/buildings/buildings.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { CalendarEmailModule } from './modules/calendar-email/calendar-email.module';
import { ContractorPortalModule } from './modules/contractor-portal/contractor-portal.module';
import { ContractorsModule } from './modules/contractors/contractors.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ExportModule } from './modules/export/export.module';
import { ExternalSharesModule } from './modules/external-shares/external-shares.module';
import { ImportsModule } from './modules/imports/imports.module';
import { MembersModule } from './modules/members/members.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { NotesModule } from './modules/notes/notes.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { OrgModule } from './modules/org/org.module';
import { OwnersModule } from './modules/owners/owners.module';
import { OwnershipsModule } from './modules/ownerships/ownerships.module';
import { ParcelSetupsModule } from './modules/parcel-setups/parcel-setups.module';
import { PortalModule } from './modules/portal/portal.module';
import { ProjectAssignmentsModule } from './modules/project-assignments/project-assignments.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProposalsModule } from './modules/proposals/proposals.module';
import { ProviderModule } from './modules/provider/provider.module';
import { RolesModule } from './modules/roles/roles.module';
import { SharesModule } from './modules/shares/shares.module';
import { SignaturesModule } from './modules/signatures/signatures.module';
import { TabuModule } from './modules/tabu/tabu.module';
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
    // P0.B2 — pluggable observability + breach-detection seam (Global).
    // Provides IMetricsProvider / IAlertSink / BreachDetectionService behind
    // tokens (Noop dev/test, real prod) and registers the global metrics
    // interceptor. Placed early so its global interceptor wraps all routes.
    ObservabilityModule,
    LoggerModule.forRoot({
      pinoHttp: {
        // Redaction policy extracted to `logging/log-redact.ts` (unit-tested in
        // log-redact.spec.ts). SEC M-2: referer/referrer are redacted there.
        redact: LOG_REDACT,
        level: process.env['NODE_ENV'] !== 'production' ? 'debug' : 'info',
      },
    }),
    AuthModule,
    ProjectsModule,
    BuildingsModule,
    ApartmentsModule,
    OwnersModule,
    OwnershipsModule,
    // S3c — "renter → discovery-source": apartment-attached discovery records
    // (occupant) replacing the retired ownerships 'renter'. CRUD under an
    // apartment; withTenant + RLS via-parent.
    DiscoveryModule,
    // S7a — "Tabu extraction envelope + lifecycle": apartment-attached
    // extraction runs pointing at a finalized source doc; draft lifecycle.
    // withTenant + RLS direct org_id; create gated by edit_project_data (D.54).
    TabuModule,
    // P3a — parcel-setup envelope + manual path → skeleton: project-attached
    // גוש-חלקה setup; STRICT no-PII draft payload; confirm = audit-first,
    // idempotent, atomic buildings+apartments creation with provenance.
    // withTenant + RLS direct org_id; writes gated by edit_project_data (D.54).
    ParcelSetupsModule,
    ContractorsModule,
    DocumentsModule,
    SharesModule,
    // X-S2/X-S3 (V13) — generalized party-typed external_share grants
    // (developer/lawyer/bank/...). ADDITIVE; the contractor tier stays on
    // SharesModule until a deliberate migration (X-S8). Manager-only writes,
    // server-side preset-ceiling enforcement (narrows-only), RLS org isolation.
    ExternalSharesModule,
    TasksModule,
    NotificationsModule,
    NotesModule,
    // Internal team messaging — member ↔ member conversations (dashboard
    // "Recent conversations" → a real feature). Participation-based authz
    // (AuthGuard + TenantGuard + RLS participant scoping + service viewer-RO),
    // deliberately OUTSIDE the IAM capability matrix. Migration 0075.
    MessagingModule,
    AuditModule,
    ProjectAssignmentsModule,
    MembersModule,
    // P2 Phase 1 — custom permission groups (org-defined roles). Management CRUD
    // + assign/revoke over the existing IAM data model; the engine enforces a
    // custom role live the moment a role_assignment references it.
    RolesModule,
    OrgModule,
    SignaturesModule,
    // Autonomous Master Plan, Phase 1 — Approval-Inbox BE (proposals read +
    // approve/reject). Reuses SignatureRequestsService.reissueExpired verbatim as
    // the first kind executor. FE inbox is a separate follow-on slice.
    ProposalsModule,
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
    // D2-DEF-1 / D.46 — Contractor read-tier (share-token, `emapp-share`
    // audience). Parallel auth tier OUTSIDE the org POLICY matrix; perms-
    // driven via the share JSONB. No migration / no policy.ts change.
    ContractorPortalModule,
    // D.38 / V11 B.S6 — Calendar / ICS generator (pure function).
    // No controller; B.S7 Resend integration consumes via DI.
    CalendarModule,
    // D.38 / V11 B.S7 — Calendar email dispatcher. Wires
    // CalendarService + IEmailProvider so TasksService can fire
    // best-effort ICS invites after task create/update/archive.
    CalendarEmailModule,
    // V11 B.S8 / Phase 7 — Project → xlsx export (pure-function
    // service). B.S10 will wire the endpoint that composes the
    // input from a withTenant read; B.S9 will add the sibling PDF
    // service on the same input shape.
    ExportModule,
  ],
  controllers: [HealthController],
  // Rate limiting ENFORCED globally; the configurable guard adds a
  // prod-safe, env-gated per-request bypass for the conformance suite.
  providers: [
    // S0-SEC — global input-validation backstop. Fail-closed NUL/invalid-UTF-8
    // reject on EVERY body/query/param at one choke-point (previously opt-in
    // only). Schema validation stays per-route (ZodValidationPipe / @ZodBody /
    // @ZodQuery); enforcement that every body/query is guarded is the static
    // CI guard `input-validation-coverage.spec.ts`.
    { provide: APP_PIPE, useClass: GlobalZodValidationPipe },
    { provide: APP_GUARD, useClass: ConfigurableThrottlerGuard },
    // Optional-but-honoured Idempotency-Key on mutating POSTs (D.16-safe
    // replay, concurrency-correct). Global; no-ops unless the header is
    // present on a non-auth POST.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
