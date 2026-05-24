/**
 * IMappingResolver — D.34 Layer-strategy seam.
 *
 * The worker doesn't know (and shouldn't know) WHERE a header→canonical
 * mapping comes from. It only knows:
 *   1. give me headers
 *   2. tell me a resolved ColumnMapping, OR
 *   3. tell me you can't (so the row goes to awaiting_mapping)
 *
 * Strategies (resolved in order; first hit wins):
 *
 *   L1: `LegacyAliasResolver` — the deterministic alias registry from
 *       Phase 6 S4. Pure function over headers. ~80% of common files.
 *       Implemented (this file).
 *
 *   L2: `TemplateResolver` — looks up mapping_templates by fingerprint
 *       (sha256 of normalised headers sorted, see resolveMapping line
 *       226 — "When customizable templates land, the registry pattern
 *       stays — we add a `mapping_templates` table"). Reads must
 *       respect: only `approved_by IS NOT NULL` AND `archived_at IS
 *       NULL`. NOT yet implemented — depends on S8 wizard creating
 *       templates first.
 *
 *   L3: `AgentResolver` — Phase 7+. Sends ONLY headers + canonical
 *       field semantic descriptions to an LLM; receives a proposed
 *       mapping with confidence. NOT auto-applied — manager approves
 *       via the wizard, which inserts a Layer-2 row with source='agent'.
 *
 * The handler today uses `LegacyAliasResolver` as its only injected
 * resolver. Tomorrow, `main.ts` composes a chain of all three. The
 * IMappingResolver contract is fixed so the chain composition stays
 * additive (Open/Closed Principle).
 */
import { createHash } from 'node:crypto';

import { mappingTemplates, withTenant } from '@emapp/db';
import { and, eq, sql } from 'drizzle-orm';

import { MappingError, resolveMapping, type ColumnMapping } from './mapping';

/** Result of a resolver attempt. */
export type ResolveResult =
  | { kind: 'resolved'; mapping: ColumnMapping; source: 'legacy' | 'template' | 'agent' }
  /** Resolver doesn't know; caller should try the next strategy. */
  | { kind: 'unknown' }
  /** Resolver decisively says this file is bad (e.g. duplicate column
   *  alias to two different canonicals). Different from `unknown` —
   *  no later strategy will fix it; the worker should fail-loud. */
  | { kind: 'reject'; reason: string };

/** Context threaded to resolvers that need DB access. Optional so the
 *  pure L1 path (`mapping-resolver.spec.ts` chain unit tests) continues
 *  to work without a tenant. L2 + L3 inspect this and refuse to resolve
 *  if it's missing.
 *
 *  Why widen the contract: D.34's L2 TemplateResolver looks up rows in
 *  `mapping_templates` scoped by org (RLS FORCE). The chain must pass
 *  orgId through. Alternatives considered: (a) per-handle resolver
 *  instances — breaks the singleton-chain-in-main.ts composition
 *  pattern; (b) a separate `resolveForOrg(headers, orgId)` method —
 *  violates ISP (L1 implementers would need a useless second method).
 *  Widening the existing method with an optional ctx is the
 *  Open/Closed-correct choice. */
export interface ResolveContext {
  readonly orgId: string;
  /** Optional logger so the chain can record which strategy actually
   *  resolved (or rejected). The worker injects its pino-scoped logger;
   *  tests can pass undefined. */
  readonly log?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** A strategy in the L1/L2/L3 chain. Pure on inputs; no internal state.
 *  Implementations MAY hold a TenantTx (Layer 2 needs DB access). */
export interface IMappingResolver {
  /** Strategy name for logging / audit / observability. */
  readonly name: string;
  /** Try to resolve. Return 'unknown' to defer to the next strategy. */
  resolve(headers: string[], ctx?: ResolveContext): Promise<ResolveResult>;
}

/** L1 — wraps the deterministic `resolveMapping` from mapping.ts.
 *  This is what the handler USED to call directly; now it goes through
 *  the resolver contract so L2 + L3 can plug in front of / behind it. */
export class LegacyAliasResolver implements IMappingResolver {
  readonly name = 'legacy-alias';
  async resolve(headers: string[]): Promise<ResolveResult> {
    try {
      const mapping = resolveMapping(headers);
      return { kind: 'resolved', mapping, source: 'legacy' };
    } catch (e) {
      if (e instanceof MappingError && e.code === 'mapping_incomplete') {
        // Recoverable — Layer 2 (saved template) or Layer 3 (agent) may
        // still resolve it. Tell the chain to keep trying.
        return { kind: 'unknown' };
      }
      if (e instanceof MappingError && e.code === 'mapping_duplicate') {
        // NOT recoverable by any later layer — duplicate aliases in the
        // file itself is a malformed input. Reject loud.
        return { kind: 'reject', reason: `duplicate_alias: ${e.fields.join(',')}` };
      }
      throw e;
    }
  }
}

/** Compute the canonical headers-fingerprint used by L2 lookups + the
 *  S8 wizard's template insertion. Single source of truth for the
 *  algorithm so worker + api never drift.
 *
 *  Normalisation: trim + lowercase each header, join with NUL.
 *    - Trim: tolerates trailing whitespace in pasted-from-PDF headers.
 *    - Lowercase: tolerates case drift (Hebrew letters are
 *      case-invariant so this is a no-op there; English aliases like
 *      "National_ID" vs "national_id" collapse to one fingerprint).
 *    - NUL separator: guaranteed not to appear in any legal header
 *      (Excel forbids NUL in cell text). Prevents "ab"+"c" colliding
 *      with "a"+"bc" if we used a printable separator.
 *
 *  The api service's `submitMapping` MUST call this same function to
 *  keep the L2 lookup key consistent. */
export function fingerprintHeaders(headers: readonly string[]): string {
  const normalised = headers.map((h) => h.trim().toLowerCase()).join('\x00');
  return createHash('sha256').update(normalised).digest('hex');
}

/** v6 audit fix (P0 cross-confirmed by security agent — SAME class as
 *  v5's sanitiseFilenameForAudit, applied at MORE persistence boundaries).
 *
 *  v5 introduced `sanitiseFilenameForAudit` for the audit-log fileName
 *  surface but missed three other Manager-supplied string boundaries that
 *  end up in persisted, queryable columns:
 *    1. `import_jobs.parsed_headers` — worker writes raw header strings
 *       from the parsed Excel. Headers like "Owner_038123456_phone"
 *       (Manager-named columns referring to specific individuals) put
 *       9-digit Israeli-ID-shaped substrings into a Manager-readable
 *       jsonb column with NO encryption.
 *    2. `mapping_templates.mapping.headers` — wizard echoes parsed_headers
 *       into the template's jsonb. Templates persist indefinitely
 *       (soft-delete only) — a single malicious-header file would poison
 *       the org's template library FOREVER.
 *    3. `mapping_templates.name` — Manager-supplied (Zod-bounded to 120
 *       chars but no content filter). A template named "Owner 038123456
 *       mapping" lands the PII substring in a queryable column.
 *
 *  Strategy: same as v5's filename helper — strip any run of 7+ digits.
 *  7 is below the Israeli national_id length (9) but above year/month/seq
 *  number lengths (≤4) so we catch PII shapes without mangling legitimate
 *  filenames like "2026" or "Q1_2026".
 *
 *  The fingerprint is computed from the LIVE headers (in memory, NOT the
 *  sanitised copy) so L2 lookups still find templates for files with the
 *  exact same header strings. The sanitised copy is the PERSISTED artifact.
 *  This is the same trick v5 applied to fileName: the row keeps the
 *  cleartext (RLS-protected; uploader UX needs it), the audit gets the
 *  sanitised version. */
export function sanitiseUserString(s: string): string {
  return s.replace(/\d{7,}/g, '[N]');
}

/** Apply `sanitiseUserString` to every string in an array. Returns a new
 *  array; original is untouched (callers MAY still need the cleartext for
 *  fingerprint computation in the same scope). */
export function sanitiseUserStrings(arr: readonly string[]): string[] {
  return arr.map(sanitiseUserString);
}

/** L2 — TemplateResolver. Looks up the org's saved mapping_templates by
 *  (orgId, fingerprint) — same algorithm + same partial UNIQUE constraint
 *  the S8 wizard uses when storing manual templates. D.34 contract.
 *
 *  Returns:
 *    - 'resolved' (source='template') when an active template matches.
 *      Distinguishes manager-approved vs agent-only: agent rows REQUIRE
 *      approved_by IS NOT NULL to be auto-applied (otherwise a low-
 *      confidence agent guess would silently materialise customer
 *      data — ISO A.18.1.4 violation). Manual + system templates have
 *      approved_by enforced by the table's CHECK constraint.
 *    - 'unknown' otherwise (no row, or unapproved agent row).
 *
 *  This resolver NEVER returns 'reject'. The reject path is L1's
 *  responsibility (duplicate-alias in the FILE), not L2's (a missing
 *  template is just an unknown, not malformed input).
 *
 *  Defense-in-depth: the row is fetched via `withTenant(orgId)` so RLS
 *  FORCE applies. The mapping JSON is also validated against the
 *  canonical-field shape before being trusted — a corrupted template
 *  (e.g. a Provider Admin accidentally inserted bad JSON via bypassRLS)
 *  is treated as 'unknown' rather than poisoning the import. */
export class TemplateResolver implements IMappingResolver {
  readonly name = 'template';

  async resolve(headers: string[], ctx?: ResolveContext): Promise<ResolveResult> {
    if (!ctx?.orgId) {
      // L2 requires a tenant context. Without one, defer to the next
      // strategy (this is also the path the existing chain-unit
      // tests take when they don't pass a ctx).
      return { kind: 'unknown' };
    }

    const fingerprint = fingerprintHeaders(headers);

    let rows: Array<typeof mappingTemplates.$inferSelect>;
    try {
      rows = await withTenant(ctx.orgId, async (tx) =>
        tx
          .select()
          .from(mappingTemplates)
          .where(
            and(
              eq(mappingTemplates.fingerprint, fingerprint),
              sql`${mappingTemplates.archivedAt} IS NULL`,
            ),
          )
          .limit(1),
      );
    } catch (e) {
      // DB error during a lookup must NOT bring down the chain. Log
      // and defer to the next strategy. The worker's main loop will
      // surface the import as awaiting_mapping if L1+L3 both also
      // miss, which is the safe failure mode.
      ctx.log?.warn?.('TemplateResolver lookup failed; deferring', {
        reason: e instanceof Error ? e.name : 'unknown',
      });
      return { kind: 'unknown' };
    }

    if (rows.length === 0) {
      return { kind: 'unknown' };
    }
    const tpl = rows[0]!;

    // Refuse unapproved agent rows. The table's CHECK constraint
    // enforces approval pairing for manual rows; for agent rows the
    // CHECK allows approved_by=NULL (so an agent can stage a
    // suggestion without claiming it's manager-blessed). We DO NOT
    // auto-apply unapproved agent guesses — that would defeat the
    // entire purpose of the wizard's approval gate.
    if (tpl.source === 'agent' && tpl.approvedBy === null) {
      ctx.log?.info?.('TemplateResolver — found unapproved agent template; deferring', {
        template_id: tpl.id,
      });
      return { kind: 'unknown' };
    }

    // Defensive shape validation. The mapping jsonb stores
    // `{columns: Record<canonical, number>, headers: string[]}`. If
    // shape is wrong → defer (don't crash the import). This shouldn't
    // happen with templates created by the wizard (Zod-validated) but
    // defense-in-depth against a future SQL-inserted row.
    const payload = tpl.mapping as unknown;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as { columns?: unknown }).columns !== 'object'
    ) {
      ctx.log?.warn?.('TemplateResolver — malformed template mapping jsonb; deferring', {
        template_id: tpl.id,
      });
      return { kind: 'unknown' };
    }

    const columns = (payload as { columns: Record<string, number> }).columns;
    // Sanity check the required canonical fields. Same set the wizard
    // enforces via Zod. Missing required field → defer (template is
    // incomplete; L1 will have already deferred for the same headers,
    // so we're not regressing).
    const REQUIRED = [
      'national_id',
      'phone',
      'name',
      'apartment_number',
      'building_address',
    ] as const;
    for (const f of REQUIRED) {
      if (typeof columns[f] !== 'number') {
        ctx.log?.warn?.('TemplateResolver — template missing required field; deferring', {
          template_id: tpl.id,
          field: f,
        });
        return { kind: 'unknown' };
      }
    }

    ctx.log?.info?.('TemplateResolver resolved', {
      template_id: tpl.id,
      source: tpl.source,
    });

    return {
      kind: 'resolved',
      source: 'template',
      mapping: {
        columns,
        unmapped: [],
        ambiguous: [],
      },
    };
  }
}

/** Compose a chain. Tries each in order; first 'resolved' or 'reject'
 *  wins. If all return 'unknown', the final result is 'unknown' — the
 *  handler interprets this as "send to awaiting_mapping state". */
export class MappingResolverChain implements IMappingResolver {
  readonly name = 'chain';
  constructor(private readonly resolvers: readonly IMappingResolver[]) {}
  async resolve(headers: string[], ctx?: ResolveContext): Promise<ResolveResult> {
    for (const r of this.resolvers) {
      const result = await r.resolve(headers, ctx);
      if (result.kind !== 'unknown') {
        return result;
      }
    }
    return { kind: 'unknown' };
  }
}
