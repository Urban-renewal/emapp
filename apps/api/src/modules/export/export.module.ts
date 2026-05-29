import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';

import { ExportComposerService } from './export-composer.service';
import { ExportRateLimitService } from './export-rate-limit.service';
import { ExportController } from './export.controller';
import { ExportService } from './export.service';
import { PdfExportService } from './pdf-export.service';

/**
 * V11 B.S8 + B.S9 + B.S10 — Project export module (Phase 7 / Doc 03 §11).
 *
 * Three concerns, one module:
 *   - `ExportService` (B.S8) — xlsx renderer (pure function).
 *   - `PdfExportService` (B.S9) — PDF renderer (pure function over the
 *     SAME `ProjectExportInput` so both formats share columns).
 *   - `ExportComposerService` (B.S10) — loads project sub-tree under
 *     `withTenant`, decrypts owner PII, writes the audit row, shapes
 *     the `ProjectExportInput`.
 *   - `ExportController` (B.S10) — `GET /api/v1/projects/:id/export?
 *     format=xlsx|pdf` with manager/agent/viewer access, 10/hour
 *     throttle, RFC 5987 Hebrew-safe Content-Disposition header.
 *
 * AuthModule import is required because the controller stacks
 * `AuthGuard` + `TenantGuard` (both live in AuthModule).
 */
@Module({
  imports: [AuthModule],
  controllers: [ExportController],
  providers: [ExportService, PdfExportService, ExportComposerService, ExportRateLimitService],
  exports: [ExportService, PdfExportService],
})
export class ExportModule {}
