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
 * NO writes — Gate-6. Any attempt to add a write handler should fail
 * code review against D.37 "Out of scope" + require a separate D.NN
 * entry before implementation.
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ProviderAuditController } from './provider-audit.controller';
import { ProviderAuditService } from './provider-audit.service';
import { ProviderAuthorizationGuard } from './provider-authorization.guard';
import { ProviderRequestAuditInterceptor } from './provider-request-audit.interceptor';
import { ProviderSystemHealthController } from './provider-system-health.controller';
import { ProviderSystemHealthService } from './provider-system-health.service';
import { ProviderTenantDetailController } from './provider-tenant-detail.controller';
import { ProviderTenantDetailService } from './provider-tenant-detail.service';
import { ProviderTenantsController } from './provider-tenants.controller';
import { ProviderTenantsService } from './provider-tenants.service';
import { DefaultSystemStatsProvider, SYSTEM_STATS_PROVIDER } from './system-stats';

@Module({
  imports: [AuthModule],
  // All 4 D.37 endpoints registered.
  controllers: [
    ProviderTenantsController,
    ProviderTenantDetailController,
    ProviderAuditController,
    ProviderSystemHealthController,
  ],
  providers: [
    ProviderTenantsService,
    ProviderTenantDetailService,
    ProviderAuditService,
    ProviderSystemHealthService,
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
