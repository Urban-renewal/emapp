/**
 * D.37 / Phase 6.5 — Provider Admin BE module.
 *
 * Registers the four read-only data endpoints under `/api/v1/provider/*`:
 *   - GET /provider/tenants
 *   - GET /provider/tenants/:id
 *   - GET /provider/audit
 *   - GET /provider/system-health
 *
 * Auth is handled by `ProviderAuthGuard` (defined in
 * `apps/api/src/modules/auth/provider/` and EXPORTED from `AuthModule`)
 * — applied per-controller-method via `@UseGuards(ProviderAuthGuard)`
 * rather than a module-wide guard so a future public sub-route (e.g.
 * /provider/health/ping for ops uptime checks) can opt out explicitly.
 *
 * Wiring contract (post P6.5-1 hardening): this module imports
 * `AuthModule` to inherit `ProviderAuthGuard`, `ProviderAuthService`,
 * and `JwtModule` (with the real JWT_SECRET). The earlier draft
 * registered duplicate providers + an empty `JwtModule.register({})`,
 * which worked by accident (the guard passes `secret: serverEnv.JWT_SECRET`
 * directly to `jwt.verify`) but created TWO instances of
 * ProviderAuthService and would silently break the moment that
 * explicit-secret defense is removed. Matches the codebase convention
 * (see `ProjectsModule`, `AuditModule`, etc.).
 *
 * Writes (D.49): suspend/reactivate tenant land here as the FIRST
 * authorized Provider write. They are gated by the SAME two-layer guard
 * stack plus `@RequireProviderAction('write')` → the matrix's `write`
 * action (Gate-6, authorized in D.49). Destructive/irreversible actions
 * (purge) remain out of scope until a separate D.NN entry.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EMAIL_PROVIDER, emailProviderFactory } from '../members/invite-email';

import { ProviderAuditController } from './provider-audit.controller';
import { ProviderAuditService } from './provider-audit.service';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderOnboardingController } from './provider-onboarding.controller';
import { ProviderOnboardingService } from './provider-onboarding.service';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';
import { ProviderSystemHealthController } from './provider-system-health.controller';
import { ProviderSystemHealthService } from './provider-system-health.service';
import { ProviderTenantDetailController } from './provider-tenant-detail.controller';
import { ProviderTenantDetailService } from './provider-tenant-detail.service';
import { ProviderTenantSuspensionController } from './provider-tenant-suspension.controller';
import { ProviderTenantSuspensionService } from './provider-tenant-suspension.service';
import { ProviderTenantUsersController } from './provider-tenant-users.controller';
import { ProviderTenantUsersService } from './provider-tenant-users.service';
import { ProviderTenantsController } from './provider-tenants.controller';
import { ProviderTenantsService } from './provider-tenants.service';
import { DefaultSystemStatsProvider, SYSTEM_STATS_PROVIDER } from './system-stats';

@Module({
  imports: [AuthModule],
  // 4 read (D.37) + 1 write surface (D.49 suspend/reactivate) registered.
  controllers: [
    ProviderTenantsController,
    ProviderTenantDetailController,
    // P4 (PLAN-provider-console §3 Tier-1 #1) — masked org-users read.
    ProviderTenantUsersController,
    ProviderAuditController,
    ProviderSystemHealthController,
    ProviderTenantSuspensionController,
    // D.45 — Provider-initiated onboarding (create org + first-manager invite).
    ProviderOnboardingController,
  ],
  providers: [
    ProviderTenantsService,
    ProviderTenantDetailService,
    ProviderTenantUsersService,
    ProviderTenantSuspensionService,
    ProviderAuditService,
    ProviderSystemHealthService,
    ProviderOnboardingService,
    // D.45 — onboarding sends the first-manager invite email through the
    // same governed IEmailProvider factory the members module uses (Fake
    // in dev/test; fails fast at boot in prod until Resend is wired, D.27).
    { provide: EMAIL_PROVIDER, useFactory: emailProviderFactory },
    // D.37 closeout gap #3 — PROVIDER_POLICY runtime enforcement.
    // Registered as a class-provider so the 4 controllers' `@UseGuards`
    // can resolve it from DI. Pure (no constructor deps) so it could
    // be `new`d inline, but DI keeps the test pattern uniform with
    // the rest of the codebase.
    ProviderAuthorizationGuard,
    // Audit v1.1 SA-6 — module-scoped interceptor that writes a
    // `provider.request.received` row in an autonomous tx BEFORE
    // ZodValidationPipe runs. Closes the "rejected requests leave
    // no audit trace" gap (ISO 27001 A.12.4.1).
    ProviderRequestAuditInterceptor,
    // Audit v1.1 SA-12 — system-stats abstraction (mirrors
    // STORAGE_PROVIDER / JOB_PRODUCER). Production wires the default
    // delegate that calls `getPoolStats` / `getStorageErrorStats` from
    // `@emapp/db`; tests can `overrideProvider(SYSTEM_STATS_PROVIDER)`
    // with a stub.
    { provide: SYSTEM_STATS_PROVIDER, useClass: DefaultSystemStatsProvider },
  ],
})
export class ProviderModule {}
