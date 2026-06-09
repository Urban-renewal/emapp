/**
 * D.37 / Audit v1.1 closures — pure validators for the Provider tier.
 *
 * Single source of truth for what counts as a valid `access_reason`,
 * `action_type`, `provider_user_id`, and audit `metadata` payload.
 *
 * **Why this module exists:**
 *   - **Audit v1.1 / CC-3** (SOLID-HIGH) — `withProvider()` was a 100-line
 *     function that did UUID validation, reason sanitisation, action
 *     regex, metadata JSON-budget, pool checkout, GUC setup, audit
 *     INSERT, and tx orchestration. Extracting the four pure validators
 *     shrinks the wrapper to a 30-line orchestrator and makes each rule
 *     independently testable without a pool client.
 *   - **Audit v1.1 / SA-13** (DRY) — the `access_reason` rules existed
 *     twice (decorator + wrapper); the constants drifted (`X-Reason`
 *     vs `access_reason`). Both call sites now import from here.
 *   - **Audit v1.1 / CC-2** (ISO 27001 A.9.4.1) — the 5-char floor was a
 *     checkbox: `"aaaaa"` passed. The new quality rule requires either
 *     a recognised ticket reference OR substantive free text (≥20
 *     chars, ≥3 whitespace-separated tokens, ≥4 distinct characters).
 *
 * Used by:
 *   - `apps/api/src/modules/provider/access-reason.decorator.ts` —
 *     HTTP-boundary validation (400 `reason_required`).
 *   - `packages/db/src/wrappers/with-provider.ts` —
 *     wrapper-boundary defence-in-depth (caller may bypass the HTTP
 *     decorator — e.g. a CLI tool or scheduled job).
 *
 * All validators are PURE: no I/O, no globals, no Date.now().
 * Failure modes return `{ ok: false, code, detail }` so the caller
 * chooses the HTTP status code; throwing is reserved for the caller's
 * decorator/wrapper layer.
 */

// ───────────────────────────────────────────────────────────────────
// Constants — exported so tests can pin the contract precisely.
// ───────────────────────────────────────────────────────────────────

/** UUID v4-ish — same shape used across the codebase. */
export const PROVIDER_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Character ranges stripped from `access_reason` before validation:
 *   - 0x00-0x1f + 0x7f (DEL) — control chars that corrupt log greps and
 *     confuse parsers reading the `app.access_reason` GUC.
 *   - U+202A-202E (bidi embeddings + LRO/RLO overrides) and U+2066-2069
 *     (bidi isolates) — these can VISUALLY SPOOF a rendered audit reason
 *     (an investigator reads reversed / disguised text). They arrive
 *     percent-encoded (e.g. %E2%80%AE) and only become live marks after
 *     the decorator's decode, so the strip must run AFTER decode.
 *
 * Built from code points (not a regex literal) so this source file holds
 * NO invisible bidi chars and no fragile \u escapes — fitting for a
 * bidi-spoofing defence. Defence-in-depth — the HTTP layer strips too.
 */
const PROVIDER_STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
  [0x061c, 0x061c], // ALM (Arabic letter mark)
  [0x200e, 0x200f], // LRM / RLM directional marks
  [0x202a, 0x202e], // bidi embeddings + LRO/RLO overrides
  [0x2066, 0x2069], // bidi isolates
];
// eslint-disable-next-line security/detect-non-literal-regexp -- built from the hardcoded PROVIDER_STRIP_RANGES constant above (no user input); dynamic only to avoid invisible bidi chars / fragile \u escapes in a regex literal.
export const PROVIDER_CONTROL_CHARS_REGEX = new RegExp(
  '[' +
    PROVIDER_STRIP_RANGES.map(
      ([lo, hi]) => String.fromCodePoint(lo) + '-' + String.fromCodePoint(hi),
    ).join('') +
    ']',
  'g',
);

/**
 * Minimum / maximum length AFTER control-char strip.
 * Min raised from 5 → 10 in Audit v1.1 closures: "aaaaa" was a
 * checkbox; the quality rule below adds substantive checks.
 * Max stays 512 — long enough for a ticket id + freeform context,
 * short enough that audit rows don't bloat.
 */
export const PROVIDER_REASON_MIN_LEN = 10;
export const PROVIDER_REASON_MAX_LEN = 512;

/**
 * Recognised ticket-id patterns. If the reason starts with one of
 * these (case-insensitive), the substantive-text rules don't apply
 * — a well-formed ticket reference IS substantive. Order matters
 * only for diagnostics; matching is OR.
 *
 * Patterns: `INC-1234`, `REQ-1234`, `SUP-1234`, `TKT-1234`, `JIRA-PROJ-123`,
 * `GH-123` (GitHub issue), `BUG-1234` — every alphabetic prefix in use
 * by EMAPP ops + common patterns from prospective enterprise customers.
 */
/*
 * Bounded alternation with concrete prefixes + bounded `\d{2,}`;
 * no catastrophic backtracking is possible on hostile input.
 * Manually audited as part of Audit v1.1 CC-2 closure.
 */
// eslint-disable-next-line security/detect-unsafe-regex
export const PROVIDER_TICKET_REF_REGEX = /^(INC|REQ|SUP|TKT|BUG|JIRA|GH|PR)-(?:[A-Z]+-)?\d{2,}/i;

/**
 * Substantive-text fallback when no ticket reference is found:
 *   - At least 20 chars after control-char strip.
 *   - At least 3 whitespace-separated tokens.
 *   - At least 4 distinct characters.
 *
 * Defeats the obvious abuses: "aaaaa", "test1", "....", "aaaaaaaaaaaa".
 * Passes legitimate reasons: "investigating tenant signup failure",
 * "billing reconciliation for Q2", "health check after Neon outage".
 */
const SUBSTANTIVE_MIN_LEN = 20;
const SUBSTANTIVE_MIN_TOKENS = 3;
const SUBSTANTIVE_MIN_DISTINCT_CHARS = 4;

/**
 * Action label shape — mirrors the audit-search Zod (`provider.ts`).
 * Writer MUST emit the same shape or future filters miss legitimate
 * rows. `^[a-z][a-z0-9_.-]*$` (case-insensitive), max 128 chars.
 */
export const PROVIDER_ACTION_REGEX = /^[a-z][a-z0-9_.-]*$/i;
export const PROVIDER_ACTION_MAX_LEN = 128;

/**
 * Audit metadata size budget. 8 KB after JSON.stringify.
 * Postgres jsonb handles MBs, but per-row growth at audit-log scale
 * compounds; any legitimate context (ticket id, filter snapshot,
 * error class) fits in 8 KB.
 */
export const PROVIDER_METADATA_MAX_BYTES = 8 * 1024;

// ───────────────────────────────────────────────────────────────────
// Result types — `Ok` carries the cleaned/serialised value; `Failed`
// carries a stable error code the caller maps to an HTTP status.
// ───────────────────────────────────────────────────────────────────

export interface ValidatorOk<T> {
  ok: true;
  value: T;
}
export interface ValidatorFailed<C extends string> {
  ok: false;
  code: C;
  detail: string;
}
export type ValidatorResult<T, C extends string> = ValidatorOk<T> | ValidatorFailed<C>;

// ───────────────────────────────────────────────────────────────────
// validateProviderUserId
// ───────────────────────────────────────────────────────────────────

export function validateProviderUserId(
  raw: unknown,
): ValidatorResult<string, 'provider_user_id_invalid'> {
  if (typeof raw !== 'string' || !PROVIDER_UUID_REGEX.test(raw)) {
    return {
      ok: false,
      code: 'provider_user_id_invalid',
      detail: 'providerUserId must be a valid UUID',
    };
  }
  return { ok: true, value: raw };
}

// ───────────────────────────────────────────────────────────────────
// validateProviderReason — CC-2 quality rules + SA-13 single source.
// ───────────────────────────────────────────────────────────────────

export type ReasonFailureCode = 'reason_required' | 'reason_too_long' | 'reason_low_quality';

/**
 * Sanitise + validate `access_reason`.
 *
 * Returns `{ok:true, value}` with the cleaned reason (control chars
 * stripped, trimmed) when accepted. Returns `{ok:false, ...}` with
 * one of three stable codes:
 *   - `reason_required` — empty / too short after strip / non-string
 *   - `reason_too_long` — > 512 chars after strip
 *   - `reason_low_quality` — passes length but fails substantive-text
 *     rule AND doesn't match a known ticket pattern (Audit v1.1 CC-2)
 *
 * The HTTP boundary (`AccessReason` decorator) and the wrapper
 * boundary (`withProvider`) both call this; consistency by
 * construction.
 */
export function validateProviderReason(raw: unknown): ValidatorResult<string, ReasonFailureCode> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      ok: false,
      code: 'reason_required',
      detail: 'access_reason must be a non-empty string',
    };
  }
  const cleaned = raw.replace(PROVIDER_CONTROL_CHARS_REGEX, '').trim();
  if (cleaned.length === 0) {
    return {
      ok: false,
      code: 'reason_required',
      detail: 'access_reason is empty after control-char strip',
    };
  }
  if (cleaned.length > PROVIDER_REASON_MAX_LEN) {
    return {
      ok: false,
      code: 'reason_too_long',
      detail: `access_reason must be at most ${PROVIDER_REASON_MAX_LEN} chars`,
    };
  }
  // CC-2: quality rule. A recognised ticket prefix passes immediately
  // (the prefix IS the substantive content — even short refs like
  // `INC-1234` carry forensic-traceable meaning). Otherwise enforce
  // distinct-character + token-count + length floor that defeats the
  // typical low-quality patterns. The PROVIDER_REASON_MIN_LEN check is
  // folded into the substantive-fallback path; bare ticket ids may be
  // shorter than MIN_LEN because the ticket id IS the substance.
  if (PROVIDER_TICKET_REF_REGEX.test(cleaned)) {
    return { ok: true, value: cleaned };
  }
  if (cleaned.length < PROVIDER_REASON_MIN_LEN) {
    return {
      ok: false,
      code: 'reason_required',
      detail: `access_reason must be at least ${PROVIDER_REASON_MIN_LEN} chars after control-char strip (or use a ticket-id prefix like INC-1234)`,
    };
  }
  {
    if (cleaned.length < SUBSTANTIVE_MIN_LEN) {
      return {
        ok: false,
        code: 'reason_low_quality',
        detail: `access_reason without a ticket reference (e.g. INC-1234) must be at least ${SUBSTANTIVE_MIN_LEN} chars`,
      };
    }
    const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < SUBSTANTIVE_MIN_TOKENS) {
      return {
        ok: false,
        code: 'reason_low_quality',
        detail: `access_reason without a ticket reference must contain at least ${SUBSTANTIVE_MIN_TOKENS} whitespace-separated tokens`,
      };
    }
    const distinct = new Set(cleaned.toLowerCase()).size;
    if (distinct < SUBSTANTIVE_MIN_DISTINCT_CHARS) {
      return {
        ok: false,
        code: 'reason_low_quality',
        detail: `access_reason has too few distinct characters (${distinct} < ${SUBSTANTIVE_MIN_DISTINCT_CHARS})`,
      };
    }
  }
  return { ok: true, value: cleaned };
}

// ───────────────────────────────────────────────────────────────────
// validateProviderAction
// ───────────────────────────────────────────────────────────────────

export type ActionFailureCode =
  | 'provider_action_required'
  | 'provider_action_invalid'
  | 'provider_action_too_long';

export function validateProviderAction(raw: unknown): ValidatorResult<string, ActionFailureCode> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      ok: false,
      code: 'provider_action_required',
      detail: 'action must be a non-empty string when provided',
    };
  }
  if (raw.length > PROVIDER_ACTION_MAX_LEN) {
    return {
      ok: false,
      code: 'provider_action_too_long',
      detail: `action exceeds maximum ${PROVIDER_ACTION_MAX_LEN} chars`,
    };
  }
  if (!PROVIDER_ACTION_REGEX.test(raw)) {
    return {
      ok: false,
      code: 'provider_action_invalid',
      detail: `action must match ${PROVIDER_ACTION_REGEX.source}`,
    };
  }
  return { ok: true, value: raw };
}

// ───────────────────────────────────────────────────────────────────
// validateProviderMetadata
// ───────────────────────────────────────────────────────────────────

export type MetadataFailureCode = 'provider_metadata_invalid' | 'provider_metadata_too_large';

/**
 * Validate + serialise the audit metadata payload, with `reason`
 * overlaid ON TOP of caller keys so a hostile caller cannot smuggle
 * a different reason value through `metadata.reason`. The result
 * `value` is the canonical JSON string ready to insert into the
 * `provider_audit_log.metadata` jsonb column.
 */
export function validateProviderMetadata(
  reason: string,
  custom: Record<string, unknown> | undefined,
): ValidatorResult<string, MetadataFailureCode> {
  // Reason wins — overlay order is `{ ...custom, reason }`.
  const payload: Record<string, unknown> = { ...(custom ?? {}), reason };
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch (e) {
    return {
      ok: false,
      code: 'provider_metadata_invalid',
      detail: e instanceof Error ? e.message : 'unknown serializer failure',
    };
  }
  if (typeof json !== 'string') {
    return {
      ok: false,
      code: 'provider_metadata_invalid',
      detail: 'JSON.stringify did not return a string',
    };
  }
  // Buffer.byteLength is Node-only; this module also targets the FE
  // (shared-types) so use a portable fallback.
  const byteLen =
    typeof Buffer !== 'undefined'
      ? Buffer.byteLength(json, 'utf8')
      : new TextEncoder().encode(json).length;
  if (byteLen > PROVIDER_METADATA_MAX_BYTES) {
    return {
      ok: false,
      code: 'provider_metadata_too_large',
      detail: `metadata exceeds ${PROVIDER_METADATA_MAX_BYTES} bytes (jsonb-encoded)`,
    };
  }
  return { ok: true, value: json };
}
