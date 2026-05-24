import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerPool } from '../client';
import { env } from '../env';
import * as schema from '../schema/index';
import { providerAuditLog } from '../schema/provider';

type ProviderDatabase = NodePgDatabase<typeof schema>;

interface ProviderContext {
  ip?: string;
  userAgent?: string;
  targetTable?: string;
  targetRecordId?: string;
  /**
   * D.37 / Phase 6.5 — explicit action label for the audit row.
   * Defaults to `'session'` (back-compat for pre-D.37 callers).
   * Phase 6.5 endpoints pass their specific action
   * (`'provider.tenant.viewed'` / `'provider.audit.searched'` /
   * `'provider.health.read'`).
   *
   * Shape: dot-separated identifier matching `^[a-z][a-z0-9_.-]*$`,
   * max 128 chars — SAME shape the audit-search Zod accepts in
   * `@emapp/shared-types/provider` so the writer cannot produce rows
   * the reader can't filter. Invalid → throws `provider_action_invalid`.
   */
  action?: string;
  /**
   * D.37 — additional structured metadata merged INTO
   * `provider_audit_log.metadata` (the JSONB column). The wrapper
   * ALWAYS overlays `{ reason }` on top so queries against
   * `metadata.reason` work uniformly; caller-supplied keys with the
   * literal name `reason` are intentionally overwritten (no way for
   * a caller to spoof a different reason in metadata than the one
   * recorded in the dedicated `reason` column).
   *
   * Size cap: 8 KB after JSON.stringify (Postgres jsonb best-practice
   * + audit-row bloat defense). Larger → throws `provider_metadata_too_large`.
   * Non-serializable (circular ref, BigInt, etc.) → throws
   * `provider_metadata_invalid`.
   */
  metadata?: Record<string, unknown>;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_REGEX.test(s);
}

// D.37 hardening — symmetric with the audit-search Zod (`provider.ts`):
// action filter accepts `^[a-z][a-z0-9_.-]*$` (prefix match). The
// writer MUST emit the same shape or future filters miss legitimate
// rows. Length cap mirrors the schema's `.max(128)`.
const ACTION_REGEX = /^[a-z][a-z0-9_.-]*$/i;
const ACTION_MAX_LEN = 128;

// D.37 hardening — strip control chars (0x00-0x1f, 0x7f) from the
// reason BEFORE persistence. Defense-in-depth at the wrapper level
// (the AccessReason decorator also strips at the HTTP boundary;
// withProvider can be called from non-HTTP paths so it MUST repeat).
// Postgres TEXT accepts these bytes but they corrupt log greps and
// can confuse downstream parsers reading the `app.access_reason` GUC.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f]/g;
function sanitizeReason(raw: string): string {
  return raw.replace(CONTROL_CHARS_REGEX, '').trim();
}

const REASON_MIN_LEN = 5;
const REASON_MAX_LEN = 512;

// D.37 hardening — bytes after JSON.stringify. 8 KB chosen because
// (a) Postgres jsonb stores fine up to MB, but the audit_log GROWS
// linearly with traffic, and (b) any legitimate audit context fits
// in 8 KB (ticket #, filter blob, error class). Larger → caller bug
// or DoS attempt; reject loudly.
const METADATA_MAX_BYTES = 8 * 1024;

interface MetadataValidationOk {
  ok: true;
  json: string;
}
interface MetadataValidationFailed {
  ok: false;
  code: 'provider_metadata_invalid' | 'provider_metadata_too_large';
  detail: string;
}

function validateMetadata(
  reason: string,
  custom: Record<string, unknown> | undefined,
): MetadataValidationOk | MetadataValidationFailed {
  // Overlay order: caller's keys FIRST, then `reason` written ON TOP
  // so a hostile caller cannot smuggle a fake reason value through
  // metadata.reason (T6.5-D37-0e pins this).
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
  // JSON.stringify of valid input MAY still return `undefined` for
  // certain pathological inputs (function values etc.) — defense.
  if (typeof json !== 'string') {
    return {
      ok: false,
      code: 'provider_metadata_invalid',
      detail: 'JSON.stringify did not return a string',
    };
  }
  if (Buffer.byteLength(json, 'utf8') > METADATA_MAX_BYTES) {
    return {
      ok: false,
      code: 'provider_metadata_too_large',
      detail: `metadata exceeds ${METADATA_MAX_BYTES} bytes (jsonb-encoded)`,
    };
  }
  return { ok: true, json };
}

/**
 * The path for Provider tier (EMAPP team) access to customer data.
 *
 * Uses the provider_app_role pool (BYPASSRLS — can query across tenants).
 * EVERY call writes a provider_audit_log entry BEFORE the work runs.
 * Both the audit entry and the work are in the same transaction:
 * if the work fails, the audit row is rolled back too (but the failed
 * attempt is captured by the caller's error handler / Sentry).
 */
export async function withProvider<T>(
  providerUserId: string,
  reason: string,
  fn: (tx: ProviderDatabase) => Promise<T>,
  context?: ProviderContext,
): Promise<T> {
  if (!isUuid(providerUserId)) {
    throw new Error('withProvider: providerUserId must be a valid UUID');
  }
  // D.37 hardening: sanitize FIRST, then length-check the cleaned
  // value. A reason of "   \r\n   " trimmed-only would have looked
  // valid pre-D.37 but landed as "" in the audit log.
  const cleanReason = typeof reason === 'string' ? sanitizeReason(reason) : '';
  if (cleanReason.length < REASON_MIN_LEN) {
    throw new Error(
      `withProvider: reason is required (minimum ${REASON_MIN_LEN} chars after control-char strip)`,
    );
  }
  if (cleanReason.length > REASON_MAX_LEN) {
    throw new Error(`withProvider: reason exceeds maximum ${REASON_MAX_LEN} chars`);
  }

  // D.37 hardening: action regex + length symmetric with the audit
  // search schema. Caller can't write a row the search can't read.
  if (context?.action !== undefined) {
    if (typeof context.action !== 'string' || context.action.length === 0) {
      throw new Error('withProvider: action must be a non-empty string when provided');
    }
    if (context.action.length > ACTION_MAX_LEN) {
      throw new Error(
        `withProvider: action exceeds maximum ${ACTION_MAX_LEN} chars (provider_action_invalid)`,
      );
    }
    if (!ACTION_REGEX.test(context.action)) {
      throw new Error(
        `withProvider: action must match ${ACTION_REGEX.source} (provider_action_invalid)`,
      );
    }
  }

  // D.37 hardening: metadata serialization + size validated BEFORE
  // checking out a pool connection — fail fast, don't waste a slot.
  const metaResult = validateMetadata(cleanReason, context?.metadata);
  if (!metaResult.ok) {
    throw new Error(`withProvider: ${metaResult.code}: ${metaResult.detail}`);
  }

  const client = await providerPool.connect();
  const startedAt = new Date();

  try {
    await client.query('BEGIN');

    // All four session GUCs in one round trip (parameter-bound).
    //
    // v8.5 P0 FIX (Audit Sec P0-2): pre-v8.5 only the two provider-
    // identity GUCs were set. app.encryption_key + app.pii_hash_key
    // were silently absent, so the moment ANY Provider Admin code
    // path read a pgcrypto-decrypted column (e.g. owners.national_id
    // for a customer-data audit) `current_setting('app.encryption_key')`
    // would throw `unrecognized configuration parameter` OR — worse,
    // depending on PostgreSQL config — return an empty string and the
    // decrypt would silently yield garbage. Mirrors withTenant's
    // contract; the same env.PII_ENCRYPTION_KEY is enforced at boot
    // by verifyEncryptionStartup().
    await client.query({
      text:
        'SELECT set_config($1, $2, true), set_config($3, $4, true), ' +
        'set_config($5, $6, true), set_config($7, $8, true)',
      values: [
        'app.provider_user_id',
        providerUserId,
        'app.access_reason',
        cleanReason,
        'app.encryption_key',
        env.PII_ENCRYPTION_KEY,
        'app.pii_hash_key',
        env.PII_HASH_KEY,
      ],
    });

    // D.37 / Phase 6.5 fix (foundational invariant T6.5-D37-0):
    // populate `metadata.reason` in addition to the dedicated `reason`
    // column. Pre-Phase-6.5 the metadata jsonb was always `{}`; every
    // search/filter pattern in the rest of the codebase queries via
    // `metadata.<field>` so requiring callers to pivot through the
    // top-level reason column would be a special-case in audit search.
    // The validated JSON has the reason already overlaid (cannot be
    // smuggled — validateMetadata enforces).
    const actionType = context?.action ?? 'session';

    await client.query({
      text: `
        INSERT INTO provider_audit_log
          (provider_user_id, reason, action_type, started_at, ip, user_agent,
           target_table, target_record_id, metadata)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      values: [
        providerUserId,
        cleanReason,
        actionType,
        startedAt.toISOString(),
        context?.ip ?? null,
        context?.userAgent ?? null,
        context?.targetTable ?? null,
        context?.targetRecordId ?? null,
        metaResult.json,
      ],
    });

    const tx = drizzle(client, { schema });
    const result = await fn(tx);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

void providerAuditLog; // imported to validate schema reference
