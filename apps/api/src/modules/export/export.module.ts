import { Module } from '@nestjs/common';

import { ExportService } from './export.service';
import { PdfExportService } from './pdf-export.service';

/**
 * V11 B.S8 + B.S9 — Project export module (Phase 7 / Doc 03 §11).
 *
 * Two pure-function renderers sharing one `ProjectExportInput`
 * contract so the partner sees identical columns in both formats:
 *   - `ExportService` → xlsx (B.S8)
 *   - `PdfExportService` → PDF (B.S9; playwright-core + Heebo woff2
 *     base64-embedded so the PDF is self-contained)
 *
 * No controller, no DB, no DI deps beyond Logger. B.S10 wires the
 * `GET /api/v1/projects/:id/export?format=xlsx|pdf` endpoint and
 * composes the input inside `withTenant`.
 */
@Module({
  providers: [ExportService, PdfExportService],
  exports: [ExportService, PdfExportService],
})
export class ExportModule {}
