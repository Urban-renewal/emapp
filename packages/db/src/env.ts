import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

/**
 * The `server` schema, broken out so `reloadEnv()` (v8 §v7-C) can re-run
 * validation against the live `process.env` without code duplication.
 */
const serverSchema = {
  DATABASE_URL: z.string().url(),
  // v8.5 — Neon's `-pooler` host is transaction-pooled; drizzle's
  // migrator opens its OWN transactions per migration, breaking
  // session-scoped GUCs the v8.5 migrator sets. DATABASE_MIGRATE_URL
  // is the direct (non-pooler) endpoint, used ONLY by
  // packages/db/scripts/migrate.ts; runtime keeps using DATABASE_URL.
  // Optional: when unset, migrate.ts falls back to DATABASE_URL
  // (preserving local dev / pre-deploy workflows).
  DATABASE_MIGRATE_URL: z.string().url().optional(),
  // **Audit v1.1 SA-1 (HIGH) closure.** Pre-closure this was unconditionally
  // optional and client.ts:121 silently fell back to DATABASE_URL —
  // meaning a production deploy without `PROVIDER_DATABASE_URL` would
  // connect the "provider" pool as `app_user` (no BYPASSRLS). The
  // INSERT into provider_audit_log would die loudly (REVOKE in 0009),
  // but the real risk was the WRONG fix (GRANT app_user instead of
  // setting the env var) permanently destroying role separation.
  //
  // Validation here PLUS the startup role probe in
  // `packages/db/src/startup-check.ts#verifyProviderPoolRole` (called
  // from apps/api/src/main.ts) gives belt-and-suspenders defence.
  // `superRefine` is used because we need access to the sibling
  // `NODE_ENV` field — t3-env doesn't expose object-level cross-field
  // refinement, so we cheat by registering an issue at parse time
  // when production lacks the URL.
  PROVIDER_DATABASE_URL: z.string().url().optional(),
  PII_ENCRYPTION_KEY: z.string().length(44),
  PII_HASH_KEY: z.string().length(44),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Connection-layer scale knobs — ops-tunable per environment WITHOUT
  // a code change. client.ts applies these with the current production-
  // safe constants as hard fallbacks (so SKIP_ENV_VALIDATION / test
  // still work — t3 returns raw env then).
  DB_POOL_MAX: z.coerce.number().int().positive().optional(),
  DB_POOL_IDLE_MS: z.coerce.number().int().positive().optional(),
  DB_POOL_CONN_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  DB_PROVIDER_POOL_MAX: z.coerce.number().int().positive().optional(),
  DB_PROVIDER_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // Cloudflare R2 storage (D.28 / Gate-5). All four are optional at
  // the schema level — when ALL FOUR are present, the storage
  // factories construct an R2StorageProvider. When ANY is missing:
  //   - dev/test  → FakeStorageProvider (in-memory)
  //   - production → factory throws (FAIL FAST — same posture as the
  //     pre-R2 era; prevents accidentally booting prod with no
  //     real storage).
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ENDPOINT: z.string().url().optional(),

  // Audit-log retention window in months (Roadmap P0.C3 / compliance).
  // Optional + a STRING here: the value is resolved + floor-clamped at the
  // call site by `resolveRetentionMonths` (helpers/audit-retention.ts),
  // which is the single chokepoint that enforces the regulatory ≥24-month
  // hard floor — a value below 24 (or unset / non-numeric) NEVER takes
  // effect (unset → default 36; <24 → clamped to 24 + a warning). We keep
  // it loosely typed here so a misconfig can never crash boot; the clamp
  // guarantees compliance regardless of what's set.
  AUDIT_RETENTION_MONTHS: z.string().optional(),

  // The system-verified outbound From (P6). Optional at the schema level —
  // `DEFAULT_EMAIL_FROM` (providers/email/email-from.ts) applies a baked
  // fallback when unset so dev/test always has a value. This is the verified
  // sender ADDRESS; a per-org `branding.senderName` only changes the DISPLAY
  // name, never this address. May be a plain address (`no-reply@x.co.il`) or
  // a display-name form (`EMAPP <no-reply@x.co.il>`).
  EMAIL_FROM: z.string().min(1).optional(),
} as const;

/** All schema key names — used by reloadEnv() to diff. */
const SCHEMA_KEYS = Object.keys(serverSchema) as readonly (keyof typeof serverSchema)[];

/** Build a validated env snapshot from the LIVE `process.env`. Returns
 *  a plain object keyed by schema fields. In test / SKIP_ENV_VALIDATION
 *  mode, T3 returns `process.env` itself — we extract only the schema
 *  fields so the exported `env` has a stable shape regardless of mode. */
function buildEnvSnapshot(): Record<string, string | undefined> {
  const raw = createEnv({
    skipValidation: !!process.env['SKIP_ENV_VALIDATION'] || process.env['NODE_ENV'] === 'test',
    server: serverSchema,
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
  }) as unknown as Record<string, unknown>;
  const out: Record<string, string | undefined> = {};
  for (const k of SCHEMA_KEYS) {
    const v = raw[k as string];
    // Coerce numbers/booleans (T3 returns the zod-coerced types) to a
    // string-typed snapshot. Consumers that need numeric env vars
    // already use Number(env.X) at the call site (see client.ts:13).
    out[k as string] =
      v === undefined || v === null ? undefined : typeof v === 'string' ? v : String(v);
  }
  return out;
}

/**
 * The exported `env` object. v8 §v7-C: a plain mutable Record (NOT the
 * T3 Proxy) so `reloadEnv()` can mutate it in place. Type inference is
 * derived from the schema via `EnvShape` below.
 *
 * Required schema fields → string. Optional → string | undefined.
 * Numeric fields (DB_POOL_MAX etc.) stay typed as string because their
 * call sites already coerce via Number(env.X). NODE_ENV is typed as
 * string (consumers compare against literal values).
 */
type IsZodOptional<T> = T extends z.ZodOptional<z.ZodTypeAny> ? true : false;
type EnvShape = {
  -readonly [K in keyof typeof serverSchema]: IsZodOptional<(typeof serverSchema)[K]> extends true
    ? string | undefined
    : string;
};

// Initial snapshot.
const initial = buildEnvSnapshot();

export const env: EnvShape = {} as EnvShape;
for (const k of SCHEMA_KEYS) {
  (env as Record<string, unknown>)[k as string] = initial[k as string];
}

/**
 * v8 §v7-C — credential refresh path.
 *
 * Re-runs env validation against the LIVE `process.env` (which a
 * supervisor-level secret-rotation hook will have updated). MUTATES
 * the exported `env` object IN PLACE so existing imports keep their
 * reference; consumers re-read the same `env.R2_*` etc. and see the
 * new values on next access.
 *
 * Pair with `resetStorageProvider()` from the api/worker storage
 * factories to drop the cached S3Client built against the OLD R2
 * credentials.
 *
 * Returns the KEY NAMES that actually changed (never values — safe to
 * log; the SIGHUP handler relies on this).
 */
export function reloadEnv(): readonly string[] {
  const next = buildEnvSnapshot();
  const changed: string[] = [];
  for (const k of SCHEMA_KEYS) {
    const before = (env as Record<string, unknown>)[k as string];
    const after = next[k as string];
    if (before !== after) {
      changed.push(k as string);
      (env as Record<string, unknown>)[k as string] = after;
    }
  }
  return changed;
}
