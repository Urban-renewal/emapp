import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import { providerPool } from '../client';
import { env } from '../env';
import {
  validateProviderAction,
  validateProviderMetadata,
  validateProviderReason,
  validateProviderUserId,
} from '../helpers/provider-validators';
import * as schema from '../schema/index';

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
   * `'provider.health.read'`). Validated by `validateProviderAction`
   * (regex + length cap symmetric with the audit-search Zod).
   */
  action?: string;
  /**
   * D.37 — additional structured metadata merged INTO
   * `provider_audit_log.metadata` (the JSONB column). The wrapper
   * ALWAYS overlays `{ reason }` on top so queries against
   * `metadata.reason` work uniformly; caller-supplied keys with the
   * literal name `reason` are intentionally overwritten (no way for
   * a caller to spoof a different reason in metadata than the one
   * recorded in the dedicated `reason` column). Size-budgeted to
   * 8 KB after JSON.stringify.
   */
  metadata?: Record<string, unknown>;
}

/**
 * The path for Provider tier (EMAPP team) access to customer data.
 *
 * Uses the provider_app_role pool (BYPASSRLS — can query across tenants).
 *
 * **Audit v1.1 closures (CC-3 + SA-7 + SA-13).** Pre-closure this
 * function was a 100+-line monolith doing UUID validation, reason
 * sanitisation, action regex, metadata size budget, GUC setup, audit
 * INSERT, and tx orchestration. CC-3 (SRP cross-confirmed by both
 * SOLID agents) demanded extraction; SA-7 (audit-row suppression by
 * crafted failure) demanded the audit row land in its OWN autonomous
 * transaction so a poisoned outer tx can no longer roll the audit
 * away; SA-13 demanded the reason/action/metadata rules share ONE
 * source of truth with the HTTP decorator.
 *
 * The wrapper is now a thin orchestrator:
 *   1. Pure validators (from `@emapp/shared-types/provider-validators`)
 *      fail-fast BEFORE any pool checkout.
 *   2. **Audit INSERT runs in an autonomous transaction** on a
 *      dedicated `providerPool.connect()` — committed BEFORE the
 *      work begins. A crash / rollback / crafted-failure in `fn` can
 *      never erase the audit record. (ISO 27001 A.12.4.3 compliance.)
 *   3. **Work transaction** runs on a SECOND connection with the
 *      session GUCs set. Failure rolls back work, not audit.
 *
 * Wire shape unchanged — callers see the same signature.
 *
 * Doc 07 §8.6 references `affected_orgs`, `query_count`, `ended_at`
 * columns that the schema does have but the writer doesn't populate
 * (left for a future closure when the access pattern needs them).
 */
export async function withProvider<T>(
  providerUserId: string,
  reason: string,
  fn: (tx: ProviderDatabase) => Promise<T>,
  context?: ProviderContext,
): Promise<T> {
  // ── 1. Pure validation (fail-fast, no pool slots burned) ─────────
  const uidResult = validateProviderUserId(providerUserId);
  if (!uidResult.ok) {
    throw new Error(`withProvider: ${uidResult.code}: ${uidResult.detail}`);
  }
  const reasonResult = validateProviderReason(reason);
  if (!reasonResult.ok) {
    throw new Error(`withProvider: ${reasonResult.code}: ${reasonResult.detail}`);
  }
  const cleanReason = reasonResult.value;

  // action — optional; defaults to 'session' for back-compat.
  let actionType = 'session';
  if (context?.action !== undefined) {
    const actionResult = validateProviderAction(context.action);
    if (!actionResult.ok) {
      throw new Error(`withProvider: ${actionResult.code}: ${actionResult.detail}`);
    }
    actionType = actionResult.value;
  }

  // metadata — overlay `{ reason }` ON TOP of caller keys so a hostile
  // caller cannot smuggle a different `metadata.reason` than the one
  // recorded in the dedicated reason column.
  const metaResult = validateProviderMetadata(cleanReason, context?.metadata);
  if (!metaResult.ok) {
    throw new Error(`withProvider: ${metaResult.code}: ${metaResult.detail}`);
  }

  // ── 2. Autonomous audit INSERT (SA-7) ────────────────────────────
  // Dedicated connection, committed BEFORE the work starts. A failure
  // in `fn` rolls back the WORK transaction but leaves the audit row
  // permanent. ISO 27001 A.12.4.3 — audit cannot be suppressed by
  // crafted-failure input.
  const startedAt = new Date();
  const auditClient = await providerPool.connect();
  try {
    await auditClient.query('BEGIN');
    // We still need provider_user_id + reason GUCs so any RLS / DB
    // trigger on `provider_audit_log` (none today, but defence in
    // depth) sees the identity. set_config(..., true) is tx-local.
    await auditClient.query({
      text: 'SELECT set_config($1, $2, true), set_config($3, $4, true)',
      values: ['app.provider_user_id', uidResult.value, 'app.access_reason', cleanReason],
    });
    await auditClient.query({
      text: `
        INSERT INTO provider_audit_log
          (provider_user_id, reason, action_type, started_at, ip, user_agent,
           target_table, target_record_id, metadata)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      values: [
        uidResult.value,
        cleanReason,
        actionType,
        startedAt.toISOString(),
        context?.ip ?? null,
        context?.userAgent ?? null,
        context?.targetTable ?? null,
        context?.targetRecordId ?? null,
        metaResult.value,
      ],
    });
    await auditClient.query('COMMIT');
  } catch (auditErr) {
    // The audit INSERT itself failed — that's a real outage (table
    // missing, role lacks INSERT, disk full). Don't swallow; the
    // caller's Sentry breadcrumb is the only safety net here.
    await auditClient.query('ROLLBACK').catch(() => {});
    auditClient.release();
    throw auditErr;
  }
  auditClient.release();

  // ── 3. Work transaction on a SECOND connection ───────────────────
  // GUCs set inside this tx; failure rolls back ONLY the work, not
  // the audit row above.
  const workClient = await providerPool.connect();
  try {
    await workClient.query('BEGIN');
    // All four session GUCs in one round trip (parameter-bound).
    // v8.5 P0-2 fix preserved: provider-tier callers that read
    // pgcrypto-decrypted columns MUST see app.encryption_key + .pii_hash_key.
    await workClient.query({
      text:
        'SELECT set_config($1, $2, true), set_config($3, $4, true), ' +
        'set_config($5, $6, true), set_config($7, $8, true)',
      values: [
        'app.provider_user_id',
        uidResult.value,
        'app.access_reason',
        cleanReason,
        'app.encryption_key',
        env.PII_ENCRYPTION_KEY,
        'app.pii_hash_key',
        env.PII_HASH_KEY,
      ],
    });

    const tx = drizzle(workClient, { schema });
    const result = await fn(tx);
    await workClient.query('COMMIT');
    return result;
  } catch (err) {
    await workClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    workClient.release();
  }
}
