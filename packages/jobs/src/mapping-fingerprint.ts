/**
 * D.34 mapping-fingerprint algorithm — SINGLE source of truth.
 *
 * v6 audit fix §2c (HIGH SOLID — cross-confirmed by SOLID + security
 * agents). Pre-fix, `fingerprintHeaders` was implemented in TWO places:
 *   - apps/worker/src/mapping/mapping-resolver.ts (L2 TemplateResolver
 *     lookup key)
 *   - apps/api/src/modules/imports/imports.service.ts (S8 wizard's
 *     `submitMapping` insert)
 * They were byte-identical TODAY (a cross-test pinned this). But a
 * "fix" in one — e.g. adding NFC unicode normalisation for Hebrew or
 * stripping zero-width joiners — would silently invalidate EVERY saved
 * template for every customer. The two callsites would compute
 * different fingerprints and L2 would never find a wizard-inserted row.
 *
 * Resolution: lift the algorithm here, in `@emapp/jobs` (already a
 * shared dep of both apps; Node-only, which is fine since worker + api
 * are both Node services). Both apps `import { fingerprintHeaders }
 * from '@emapp/jobs'`. Drift is now structurally impossible.
 *
 * Why `@emapp/jobs` (not `@emapp/shared-types`):
 *   - `node:crypto` is Node-only. shared-types is FE-safe (consumed by
 *     `@emapp/web` next.js); it can't host code that imports node:
 *     modules without breaking the FE bundle.
 *   - `@emapp/jobs` is already the boundary contract for the worker
 *     (IJobHandler, IJobProducer); the mapping-fingerprint is part of
 *     the import-job contract surface (it's the dedup key the wizard
 *     uses to insert and the worker uses to look up).
 *
 * Hash + normalisation choice:
 *   - sha256 (stable, collision-resistant, fast on Node's openssl)
 *   - trim + lowercase per header before hashing
 *   - join with NUL (\x00) — guaranteed not to appear in any legal
 *     Excel cell text; prevents "ab" + "c" colliding with "a" + "bc"
 *     that a printable separator would risk.
 *
 * The two call sites MUST use this same function. The v6 spec §2a/2b
 * cross-test pins the algorithm against an independently re-derived
 * sha256 — a divergence in this file would fail that test loudly.
 */
import { createHash } from 'node:crypto';

export function fingerprintHeaders(headers: readonly string[]): string {
  const normalised = headers.map((h) => h.trim().toLowerCase()).join('\x00');
  return createHash('sha256').update(normalised).digest('hex');
}
