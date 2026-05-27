import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzResource } from '../../common/authz/authz.decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';

import { ExportComposerService } from './export-composer.service';
import { ExportService } from './export.service';
import { PdfExportService } from './pdf-export.service';

const UuidParam = new ZodValidationPipe(z.string().uuid());
const FormatQuery = z.object({ format: z.enum(['xlsx', 'pdf']).default('xlsx') });

/**
 * V11 B.S10 — Project export endpoint (Phase 7).
 *
 * `GET /api/v1/projects/:id/export?format=xlsx|pdf`
 *
 *   - Mounted under `projects/:id/export` so the existing `projects`
 *     entry in POLICY (read = ALL) gates access. Gate-6 (policy.ts)
 *     stays untouched: this surface declares no new authz resource.
 *   - Manager/Agent/Viewer all pass `projects:read`. Agent's
 *     scope-to-assigned-projects is enforced inside ProjectsService
 *     today; the export composer would inherit the same scoping when
 *     a follow-up wires it. For MVP B.S10, an Agent who guesses an
 *     unassigned project id can export it — same posture as
 *     `GET /api/v1/projects/:id` today. Recorded as a known-debt
 *     to close in B.S10-followup OR when AuthorizationGuard learns
 *     project-scope arguments.
 *   - Throttle: 10 calls per user per hour (Doc 03 §11 — export is
 *     expensive; protects from a runaway loop on the FE side).
 *   - Audit: one `project.export` log row per call (written inside
 *     the composer's withTenant tx — same connection as the read).
 *   - Response: binary buffer + RFC 5987 `Content-Disposition`
 *     attachment with a UTF-8-encoded Hebrew filename (the FE in
 *     PR #136 parses both `filename*=UTF-8''…` and bare
 *     `filename="…"` per RFC 6266; we always emit the RFC 5987
 *     form because the partner's project names are Hebrew).
 */
@Controller('projects/:id/export')
@AuthzResource('projects')
@UseGuards(AuthGuard, TenantGuard, new AuthorizationGuard())
export class ExportController {
  constructor(
    private readonly composer: ExportComposerService,
    private readonly xlsx: ExportService,
    private readonly pdf: PdfExportService,
  ) {}

  // Docs/03 §11: "Rate limit על ייצוא (10 per user per hour)".
  // Throttler keys on the access_token cookie by default in this app
  // (verified via auth controller usage).
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @Get()
  async export(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @CurrentUser() user: AccessTokenPayload,
    @Param('id', UuidParam) projectId: string,
    @Query(new ZodValidationPipe(FormatQuery)) query: { format: 'xlsx' | 'pdf' },
  ): Promise<Buffer> {
    // Belt-and-braces: viewer is technically allowed but the FE only
    // shows the button to manager+agent. If we ever need to restrict
    // exports to writes-only roles, flip this — for now it matches
    // `projects:read = ALL`.
    if (user.role !== 'manager' && user.role !== 'agent' && user.role !== 'viewer') {
      throw new ForbiddenException({ error: { code: 'forbidden' } });
    }

    const { input } = await this.composer.composeProjectExport(user, projectId, query.format);

    const buf = await (query.format === 'pdf'
      ? this.pdf.renderProjectPdf(input)
      : this.xlsx.renderProjectXlsx(input));

    // ── Content-Disposition with Hebrew-safe filename ────────────────
    // RFC 6266 + RFC 5987: emit BOTH a plain ASCII `filename=` and
    // the percent-encoded `filename*=UTF-8''…` form. Modern clients
    // (Chrome / Firefox / Safari / curl 8+) prefer the UTF-8 form;
    // ancient clients fall back to the ASCII slug.
    const projectName = input.project.name;
    const ext = query.format === 'pdf' ? 'pdf' : 'xlsx';
    const asciiSlug = asciiSafeSlug(projectName) || `project-${projectId}`;
    const utf8Encoded = encodeURIComponent(`${projectName}.${ext}`);
    const dispositionHeader =
      `attachment; filename="${asciiSlug}.${ext}"; ` + `filename*=UTF-8''${utf8Encoded}`;

    const contentType =
      query.format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', dispositionHeader);
    reply.header('Content-Length', buf.byteLength.toString());
    // Defence-in-depth: prevent browser from rendering an xlsx/pdf
    // inline in an <iframe>. Always a download.
    reply.header('X-Content-Type-Options', 'nosniff');
    // Match the existing API's no-store posture for sensitive data.
    reply.header('Cache-Control', 'no-store');

    // Silence the `BadRequestException is unused` lint — kept on the
    // import line for future Zod-rethrow callers.
    void BadRequestException;
    void req;

    return buf;
  }
}

/**
 * ASCII-safe filename slug. Used as the RFC 5987-compatible plain
 * `filename=` fallback. Drops everything that isn't `[A-Za-z0-9._-]`
 * (replacing whitespace runs with `-`). Returns an empty string if
 * the source had no safe chars — caller substitutes `project-<uuid>`.
 *
 * Why so strict: filenames on the wire are control-char-sensitive
 * (CR/LF would inject a new HTTP header). Reject everything outside
 * the safe set rather than escape. The UTF-8 form
 * (`filename*=UTF-8''…`) is the canonical Hebrew-safe channel; the
 * ASCII slot is only for clients that can't read it.
 */
function asciiSafeSlug(s: string): string {
  // Drop any codepoint outside printable ASCII (U+0020–U+007E) — this
  // also strips control chars (CR/LF/NUL) that would otherwise inject
  // a new HTTP header. Hebrew goes through the UTF-8 channel
  // (`filename*=UTF-8''…`); the ASCII slot is just a legacy fallback.
  let out = '';
  for (const ch of s.normalize('NFKD')) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x20 && cp <= 0x7e) out += ch;
  }
  return out
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
