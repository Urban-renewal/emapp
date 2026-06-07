import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { STORAGE_PROVIDER, storageProviderFactory } from './storage';

// STORAGE_PROVIDER: Phase 4 — presigned upload/download via IStorageProvider
// (Fake in dev/test; prod FAILS FAST until R2 is an Infisical swap — same
// governed pattern as D.27 EMAIL_PROVIDER / Gate-4 NoopSMSProvider).
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, { provide: STORAGE_PROVIDER, useFactory: storageProviderFactory }],
})
export class DocumentsModule {}
