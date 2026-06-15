import { env } from './env';

/**
 * Database TARGET resolution — the single place that answers "which database,
 * and how do we reach it?".
 *
 * ## Why this exists
 *
 * A `DB_TARGET` env flag selects ONE named way to load the database; this
 * module maps that flag to the concrete connection strings every connection-
 * opener needs. Before this, switching from remote Neon to a local Postgres
 * meant ad-hoc per-process `DATABASE_URL` / `DATABASE_MIGRATE_URL` overrides
 * scattered across launcher scripts — brittle, and easy to get half-right
 * (e.g. the app pool on local but the provider pool still on Neon).
 *
 * ## SOLID
 *
 * - **Single Responsibility:** target → connection config lives here ONLY.
 *   `client.ts` (pools), `migrate.ts` (migrator) and the worker's pg-boss all
 *   consume a `ResolvedDbTarget`; none reads a raw URL env var for connecting.
 * - **Open/Closed:** a future managed-Postgres service is added by appending a
 *   name to {@link DB_TARGETS} and one entry to {@link RESOLVERS} — with ZERO
 *   changes to any consumer. Switching providers later is a one-line flag.
 * - **Fail-fast:** an unknown `DB_TARGET`, or a target whose required URL is
 *   absent, throws an actionable error at boot rather than silently connecting
 *   somewhere unexpected.
 */

/**
 * The supported database targets — the canonical list. This is the ONE place
 * the set is defined; `env.ts` keeps `DB_TARGET` loosely typed (a string) so
 * the vocabulary never has to be edited in two files.
 */
export const DB_TARGETS = ['neon', 'local'] as const;
export type DbTarget = (typeof DB_TARGETS)[number];

/** Used when `DB_TARGET` is unset — the team default (remote Neon). */
export const DEFAULT_DB_TARGET: DbTarget = 'neon';

export interface ResolvedDbTarget {
  /** Which target produced this — for the boot log / telemetry. */
  readonly target: DbTarget;
  /**
   * App pool connection. RLS APPLIES here (`withTenant` does `SET ROLE
   * app_user` + the org GUC); this is the principal customer-data path.
   */
  readonly appUrl: string;
  /**
   * Provider pool connection — the BYPASSRLS owner role (`withProvider`, plus
   * the pg-boss queue plumbing, which lives outside RLS).
   */
  readonly providerUrl: string;
  /**
   * The connection the MIGRATOR uses. It must be a session-pooled or DIRECT
   * endpoint (NOT a transaction pooler) so the session-level encryption GUCs
   * `migrate.ts` sets survive every `BEGIN` drizzle opens.
   */
  readonly migrateUrl: string;
  /**
   * True when {@link appUrl} is a transaction POOLER (Neon `-pooler`).
   */
  readonly pooled: boolean;
  /**
   * True when {@link migrateUrl} is a DIRECT (non-pooler) endpoint — i.e. safe
   * for the migrator's session GUCs. For `neon` this is true ONLY when a
   * dedicated `DATABASE_MIGRATE_URL` is set; when it falls back to the pooled
   * `DATABASE_URL`, this is false (the migrator's own guard then refuses).
   * Drives an HONEST migrate log (don't claim "direct" on the pooler fallback).
   */
  readonly migrateDirect: boolean;
}

/** The slice of `env` a resolver reads. Kept structural so the resolver is
 *  trivially unit-testable with a plain object (no real `process.env`). */
export interface DbTargetEnv {
  readonly DB_TARGET?: string;
  readonly DATABASE_URL?: string;
  readonly PROVIDER_DATABASE_URL?: string;
  readonly DATABASE_MIGRATE_URL?: string;
  readonly LOCAL_DATABASE_URL?: string;
}

/**
 * Per-target resolution strategies. Each reads ONLY the env vars ITS target
 * owns, so targets are independent — adding or misconfiguring one can never
 * perturb another. A strategy returns either the resolved config or a single
 * actionable `error` string (missing-required-url), which {@link resolveDbTarget}
 * turns into a throw.
 */
const RESOLVERS: Record<DbTarget, (e: DbTargetEnv) => ResolvedDbTarget | { error: string }> = {
  // Remote Neon (the team default). DATABASE_URL is the transaction-pooled app
  // endpoint; PROVIDER_DATABASE_URL the BYPASSRLS endpoint; DATABASE_MIGRATE_URL
  // the DIRECT endpoint the migrator needs. The `?? DATABASE_URL` fallbacks
  // preserve the pre-flag single-URL behaviour for environments that set only
  // DATABASE_URL.
  neon: (e) => {
    if (!e.DATABASE_URL) return { error: 'DB_TARGET=neon requires DATABASE_URL to be set.' };
    return {
      target: 'neon',
      appUrl: e.DATABASE_URL,
      providerUrl: e.PROVIDER_DATABASE_URL ?? e.DATABASE_URL,
      migrateUrl: e.DATABASE_MIGRATE_URL ?? e.DATABASE_URL,
      pooled: true,
      // Direct ONLY when the dedicated migrate endpoint is set; the
      // DATABASE_URL fallback is the transaction pooler (not direct).
      migrateDirect: !!e.DATABASE_MIGRATE_URL,
    };
  },
  // Local Postgres on the dev machine (~1 ms RTT vs ~165 ms to us-east-1). One
  // direct endpoint serves every role — app vs provider is decided by
  // `withTenant` / `withProvider` SET ROLE, not by separate connections — and
  // because it is direct (no pooler) the migrator uses the same URL.
  local: (e) => {
    if (!e.LOCAL_DATABASE_URL) {
      return {
        error:
          'DB_TARGET=local requires LOCAL_DATABASE_URL (e.g. ' +
          'postgresql://postgres:<pwd>@localhost:5432/emapp). See docs/LOCAL-DEV.md.',
      };
    }
    return {
      target: 'local',
      appUrl: e.LOCAL_DATABASE_URL,
      providerUrl: e.LOCAL_DATABASE_URL,
      migrateUrl: e.LOCAL_DATABASE_URL,
      pooled: false,
      // A direct local endpoint — no pooler — so the migrator is safe.
      migrateDirect: true,
    };
  },
};

/** Type guard — is `value` one of the known targets? */
export function isDbTarget(value: string): value is DbTarget {
  return (DB_TARGETS as readonly string[]).includes(value);
}

/**
 * Resolve the active database target from `env` (defaults to the live
 * `@emapp/db` env; injectable for tests). Throws on an unknown `DB_TARGET`
 * or a target whose required connection URL is missing.
 */
export function resolveDbTarget(e: DbTargetEnv = env): ResolvedDbTarget {
  const raw = e.DB_TARGET ?? DEFAULT_DB_TARGET;
  if (!isDbTarget(raw)) {
    throw new Error(
      `Unknown DB_TARGET "${raw}". Valid targets: ${DB_TARGETS.join(', ')} ` +
        `(unset → "${DEFAULT_DB_TARGET}").`,
    );
  }
  const out = RESOLVERS[raw](e);
  if ('error' in out) throw new Error(out.error);
  return out;
}
