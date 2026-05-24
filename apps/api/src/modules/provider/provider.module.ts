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
 * `apps/api/src/modules/auth/provider/`) — applied per-controller-method
 * via `@UseGuards(ProviderAuthGuard)` rather than a module-wide guard so
 * a future public sub-route (e.g. /provider/health/ping for ops uptime
 * checks) can opt out explicitly.
 *
 * NO writes — Gate-6. Any attempt to add a write handler should fail
 * code review against D.37 "Out of scope" + require a separate D.NN
 * entry before implementation.
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ProviderAuthGuard } from '../auth/provider/provider-auth.guard';
import { ProviderAuthService } from '../auth/provider/provider-auth.service';

@Module({
  // JwtModule is needed by ProviderAuthGuard.verify() — registered
  // here so this module can stand alone without depending on
  // AuthModule's internals.
  imports: [JwtModule.register({})],
  // ProviderAuthService is a transitive dep of the guard (it touches
  // isProviderSessionActive); registering as provider lets Nest
  // resolve it through DI without circular pulls.
  providers: [ProviderAuthGuard, ProviderAuthService],
  // Controllers are added in P6.5-2..5 (one per endpoint slice).
  controllers: [],
  exports: [ProviderAuthGuard],
})
export class ProviderModule {}
