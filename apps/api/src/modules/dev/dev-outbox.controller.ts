import { Controller, Delete, Get, NotFoundException } from '@nestjs/common';

import { isDevAuthBypass } from '../../common/dev-auth-bypass';
import { Public } from '../auth/decorators/public.decorator';
import { getDevEmailOutbox } from '../members/invite-email';

/**
 * DEV-ONLY email outbox inspector.
 *
 * Surfaces the exact emails the system WOULD send — captured in-memory by the
 * shared dev `FakeEmailProvider` (see `emailProviderFactory`) — so the link a
 * recipient receives can be examined end-to-end (functional / infosec /
 * error-handling) on the FakeEmail "platform" BEFORE the Resend cutover (D.27).
 *
 * SECURITY — this is a token-bearing surface (the email bodies embed signing /
 * invite / reset links), so it is FAIL-CLOSED and prod-impossible:
 *   - `@Public()` skips the org auth path (it's a developer tool, cross-org by
 *     nature, mirroring the `/dev-login` posture), and EACH handler hard-gates on
 *     `isDevAuthBypass()` — the SAME double gate (NODE_ENV==='development' AND
 *     DEV_AUTH_BYPASS==='1') the tenant-OTP / provider-MFA bypass uses.
 *   - Not active → `404` (NOT 403): the route is INVISIBLE in any env where the
 *     bypass is off, so it never advertises a token-bearing surface in prod.
 *   - Defense-in-depth: in production `getDevEmailOutbox()` is `null` anyway
 *     (the factory throws before assigning it), so even a gate regression reads
 *     nothing. `assertDevBypassNotInProduction()` (boot) is the third layer.
 *
 * The tokens shown are ALREADY dev-exposed (copy-link, `EXPOSE_INVITE_TOKEN`),
 * so this adds no exposure not already present in dev — only in dev.
 */
@Controller('dev/outbox')
export class DevOutboxController {
  /** List every captured email, newest last (capture order), with the links
   *  extracted for one-click examination. */
  @Public()
  @Get()
  list(): {
    data: {
      count: number;
      emails: Array<{
        index: number;
        to: string;
        from?: string;
        subject: string;
        tags?: Record<string, string>;
        text?: string;
        html?: string;
        links: string[];
        attachments: Array<{ filename: string; contentType?: string }>;
      }>;
    };
  } {
    this.assertDevOnly();
    const sent = getDevEmailOutbox()?.sent ?? [];
    return {
      data: {
        count: sent.length,
        emails: sent.map((m, index) => ({
          index,
          to: m.to,
          ...(m.from ? { from: m.from } : {}),
          subject: m.subject,
          ...(m.tags ? { tags: m.tags } : {}),
          ...(m.text ? { text: m.text } : {}),
          ...(m.html ? { html: m.html } : {}),
          links: extractLinks(`${m.text ?? ''}\n${m.html ?? ''}`),
          // ICS / other attachments — name + type only (the body is large + not
          // the link surface; the examiner can re-trigger if they need it).
          attachments: (m.attachments ?? []).map((a) => ({
            filename: a.filename,
            ...(a.contentType ? { contentType: a.contentType } : {}),
          })),
        })),
      },
    };
  }

  /** Clear the captured outbox — so each examination run starts clean. */
  @Public()
  @Delete()
  clear(): { data: { cleared: true } } {
    this.assertDevOnly();
    getDevEmailOutbox()?.reset();
    return { data: { cleared: true } };
  }

  /** Prod-impossible gate. 404 (not 403) keeps the route invisible off-dev. */
  private assertDevOnly(): void {
    if (!isDevAuthBypass()) throw new NotFoundException();
  }
}

/** Pull every http(s) URL out of an email body (text + html) so the examiner can
 *  click the signing/invite/reset link directly. De-duped, order-preserving.
 *  Trailing markup/quote chars are trimmed so an `href="..."` yields a clean URL. */
export function extractLinks(body: string): string[] {
  const matches = body.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(matches)];
}
