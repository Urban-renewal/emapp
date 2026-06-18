import { PostgresCacheProvider } from '@emapp/db';
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { OrgStatsController } from './org-stats.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { STATS_CACHE_PROVIDER, StatsCacheService } from './stats-cache.service';

// AuthModule exports AuthGuard, TenantGuard and JwtModule — the controllers
// reuse them (no auth logic re-implemented here).
//
// E2 Wave-0 PERF — the read-through stats cache (StatsCacheService) is wired
// here over the EXISTING PostgresCacheProvider (cache_kv). It is EXPORTED so
// the consent-affecting write modules (signatures, ownerships) can inject it
// to invalidate the org's stats epoch after a write. The concrete cache
// provider is bound to the ICacheProvider token via STATS_CACHE_PROVIDER.
@Module({
  imports: [AuthModule],
  controllers: [ProjectsController, OrgStatsController],
  providers: [
    ProjectsService,
    StatsCacheService,
    { provide: STATS_CACHE_PROVIDER, useClass: PostgresCacheProvider },
  ],
  exports: [StatsCacheService],
})
export class ProjectsModule {}
