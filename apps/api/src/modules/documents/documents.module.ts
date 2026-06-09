import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { FILE_SCAN_PROVIDER, scanProviderFactory } from './scan-provider.factory';
import { STORAGE_PROVIDER, storageProviderFactory } from './storage';

// STORAGE_PROVIDER: Phase 4 — presigned upload/download via IStorageProvider
// (Fake in dev/test; prod FAILS FAST until R2 is an Infisical swap — same
// governed pattern as D.27 EMAIL_PROVIDER / Gate-4 NoopSMSProvider).
// FILE_SCAN_PROVIDER: P0.B1 — pluggable IFileScanProvider anti-malware gate
// (Noop in dev/test; prod FAILS FAST until ClamAV is an Infisical swap — same
// governed pattern). finalize scans; download serves only scan-`clean`.
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    { provide: STORAGE_PROVIDER, useFactory: storageProviderFactory },
    { provide: FILE_SCAN_PROVIDER, useFactory: scanProviderFactory },
  ],
})
export class DocumentsModule {}
