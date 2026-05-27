import { Module } from '@nestjs/common';

import { ExportService } from './export.service';

/**
 * V11 B.S8 — Project export module (Phase 7 / Doc 03 §11).
 *
 * Pure-function ExportService — no controller, no DB, no DI deps
 * beyond Logger. B.S10 (`GET /api/v1/projects/:id/export?format=xlsx`)
 * will import this module and inject ExportService. B.S9 will add a
 * sibling PdfExportService that reads from the SAME `ProjectExportInput`
 * shape so both formats stay column-aligned.
 *
 * Exported so any downstream module can `@Inject` ExportService without
 * each one duplicating its construction.
 */
@Module({
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
