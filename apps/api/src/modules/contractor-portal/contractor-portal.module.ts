/**
 * D2-DEF-1 / D.46 — Contractor read-tier module.
 *
 * A parallel auth tier (share-access token, audience `emapp-share`),
 * deliberately OUTSIDE the org POLICY matrix. Endpoints under
 * `/api/v1/contractor/*` are gated solely by `ContractorAuthGuard` and the
 * share's JSONB permissions (perms-driven). No migration, no policy.ts
 * change — the existing `shares` row is the persistent identity.
 *
 * Imports `AuthModule` to inherit `JwtModule` (the real `JWT_SECRET`) for
 * the share-token sign/verify. Provides the same governed `STORAGE_PROVIDER`
 * factory the documents module uses (presigned R2 download).
 */
import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { STORAGE_PROVIDER, storageProviderFactory } from '../documents/storage';

import { ContractorAuthGuard } from './contractor-auth.guard';
import { ContractorReadController } from './contractor-read.controller';
import { ContractorReadService } from './contractor-read.service';
import { ShareTokenService } from './share-token.service';

@Module({
  imports: [AuthModule],
  controllers: [ContractorReadController],
  providers: [
    ShareTokenService,
    ContractorAuthGuard,
    ContractorReadService,
    { provide: STORAGE_PROVIDER, useFactory: storageProviderFactory },
  ],
  // Exported so the manager-side shares module can mint share-access links.
  exports: [ShareTokenService],
})
export class ContractorPortalModule {}
