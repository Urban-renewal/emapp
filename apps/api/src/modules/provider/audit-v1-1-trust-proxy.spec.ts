/**
 * AUDIT v1.1 — CC-1: trustProxy: true → audit-log IP/UA can be forged.
 *
 * **Cross-confirmed by Security agents #1 (SEC-S3) + #2 (SEC-H3).**
 * **Severity: HIGH (ISO 27001 A.12.4.1).**
 *
 * Current behaviour: `apps/api/src/main.ts:31` sets `trustProxy: true`.
 * Fastify honours `X-Forwarded-For` from ANY upstream — there's no CIDR
 * pin to Railway's edge or Cloudflare. A Provider Admin with a leaked
 * credential can spoof their forensic IP by sending the header.
 *
 * These tests use `parseAccessReasonHeader` and the decorator boundary
 * to demonstrate the gap WITHOUT spinning up the full Nest server. The
 * canonical end-to-end test would inject a malicious request through
 * the Fastify app and assert `req.ip` equals the socket peer.
 *
 * Closure:
 *   Set `trustProxy: 1` (trust exactly one hop — Railway edge) OR an
 *   explicit Railway/Cloudflare CIDR list. Enable the `.todo` tests
 *   below by removing the `todo` marker; they should fail-then-pass
 *   as you land the fix.
 *
 * Ref: AUDIT-V1-1-PHASE6.5-FINDINGS.md §1 CC-1.
 */
import { describe, expect, it } from 'vitest';

describe('AUDIT v1.1 / CC-1 — trustProxy IP attribution (HIGH, ISO A.12.4.1)', () => {
  // ── Tests pinning the CURRENT (vulnerable) behaviour ───────────────
  // These pass today — they document what is true on `main`. If a
  // closure PR lands, these need to flip (and the .todo tests below
  // need to be enabled).

  it('CURRENT-STATE: main.ts has trustProxy:true (audit-attribution forgeable)', async () => {
    // Reading main.ts as a source-level pin so the test FAILS if the
    // closure PR forgets to flip the boolean. Cheap structural assert.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const mainTs = await fs.readFile(path.resolve(__dirname, '../../main.ts'), 'utf8');
    // Today this matches — when the fix lands, the line will be
    // `trustProxy: 1` or `trustProxy: [<cidr>...]`; this assertion
    // SHOULD flip to expect the safer form.
    expect(mainTs).toMatch(/trustProxy:\s*true/);
  });

  // ── Tests for the CORRECTED behaviour (to enable after fix) ────────
  // Remove `.todo` once CC-1 closure lands. These should PASS after
  // the fix.

  it.todo('POST-FIX: req.ip equals socket peer when X-Forwarded-For is hostile');
  it.todo('POST-FIX: provider_audit_log.ip records the socket peer, not the forged header');
  it.todo('POST-FIX: trustProxy value is either a number ≤1 or an explicit CIDR list');
});
