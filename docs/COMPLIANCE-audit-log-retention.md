# Audit-log retention policy (Roadmap P0.C3)

Status: **implemented and ENABLED** (config + prune + schedule + DB carve-out)
— see [§5 DB carve-out](#5-db-carve-out-the-age-gated-immutability-trigger).
The retention WINDOW, the compliance FLOOR, the prune job and the worker
schedule are all in place, and migration `0060` (Gate-6) replaced the blanket
append-only trigger with a TIGHT age-gated carve-out so the prune's `DELETE`
now succeeds for rows past the 24-month floor — and ONLY for those rows.

---

## 1. The regulatory requirement

The Israeli **Protection of Privacy Regulations (Data Security), 2017** —
the high-tier database obligations — require that **access / security logs be
retained for at least 24 months** (the log-keeping clause, §17).

`audit_log` is EMAPP's forensic trail (ISO 27001 A.12.4): every authn/authz
event, every PII access, every administrative mutation. Historically it was
**never pruned** — so it satisfied the ≥24-month floor only _by accident_
(unbounded growth), with **no enforced, evidenced policy and no growth
ceiling**. This work turns "keep everything forever by omission" into an
**explicit, evidenced retention policy with a compliance floor that cannot be
misconfigured away**.

## 2. The policy

| Property                      | Value                          | Where                            |
| ----------------------------- | ------------------------------ | -------------------------------- |
| **Hard floor** (unbypassable) | **24 months**                  | `AUDIT_RETENTION_FLOOR_MONTHS`   |
| **Default window**            | **36 months**                  | `AUDIT_RETENTION_DEFAULT_MONTHS` |
| **Operator override**         | `AUDIT_RETENTION_MONTHS` (env) | `packages/db/src/env.ts`         |
| **Cadence**                   | **daily, 03:15 UTC**           | `AUDIT_RETENTION_CRON_DAILY`     |
| **Delete strategy**           | **batched** (5 000 rows/txn)   | `pruneAuditLog`                  |

- The window is **operator-configurable** via `AUDIT_RETENTION_MONTHS`, but it
  is **clamped to the 24-month floor in code**: any value below 24 (or unset /
  non-numeric) NEVER takes effect.
  - unset / empty / junk → **default 36**.
  - any value `< 24` → **raised to 24** and a `warn` is logged (the override is
    visible but does not take effect).
  - any value `≥ 24` → honoured (operators may keep logs **longer** than the
    floor, never shorter).
- The clamp lives in a single pure function, `resolveRetentionMonths`
  (`packages/db/src/helpers/audit-retention.ts`), so EVERY caller inherits the
  floor. This is what guarantees compliance even on a fat-fingered misconfig
  (e.g. someone sets `12` to save space — the prune still keeps 24 months).

This satisfies the high-tier reg's log-retention clause: **the effective
retention window is provably ≥ 24 months under every configuration.**

## 3. The prune

- `pruneAuditLog(log, opts)` deletes `audit_log` rows where
  `created_at < now() - make_interval(months => <effective window>)`.
- The cutoff is computed **server-side** (DB clock) — no app/DB clock-skew
  window — using the **floor-clamped** months value, so a row younger than 24
  months can never match, by construction.
- The delete is **batched** (`DELETE ... WHERE id IN (SELECT id ... LIMIT n)`
  in a loop) so each statement is a short, index-assisted transaction — never
  one giant lock on a large table. A `maxBatches` safety cap prevents an
  infinite loop; on a cap-hit the next scheduled run continues draining.
- Runs on the **BYPASSRLS maintenance pool** (`providerDb` /
  `PROVIDER_DATABASE_URL`) — the same bounded, documented exception the
  ephemeral reaper, the pg-boss plumbing and the migrations use. This is a
  system cross-org cleanup, not tenant data access, so neither `withTenant`
  (RLS-scoped) nor `withProvider` (expects a real provider principal + per-row
  audit) fits.

### Why a SEPARATE job from the ephemeral reaper

The ephemeral reaper (`reap-expired-rows.ts`, `reaper:expired-rows`, hourly)
deletes rows the app already treats as **dead the instant they expire** (short
TTLs — sessions / OTP / cache). `audit_log` is the **opposite**: every row is
**live forensic evidence for ≥24 months**. Folding it into `REAP_TARGETS`
would couple a compliance floor to a housekeeping list and invite a future
edit to the short-TTL predicates to silently nuke the audit trail. Retention
is its own single-responsibility job (`retention:audit-log`, daily) with its
own ≥24-month logic, cadence and evidence.

## 4. Evidence / observability

Each run emits a structured log line — the **evidenced policy** the reg wants:

```
audit retention prune complete
  { effective_retention_months, deleted, batches, hit_batch_cap }
```

Effective window + integer counts **only** — never row content (`audit_log`
rows carry `national_id` / `ip` / before-after state, which are NEVER read or
logged). A below-floor misconfig additionally logs a `warn` naming the
configured vs floor months. These lines are the auditor-facing artefact that
the policy is enforced and how much it removed.

> Note: we deliberately do NOT write a self-referential `audit_log` row
> recording that the prune ran. `audit_log.org_id` is a `NOT NULL` FK to
> `organizations` (`ON DELETE RESTRICT`) and there is no system/nil-org
> concept; a cross-org maintenance tick has no single org to attribute the row
> to, and fabricating one would be wrong. The structured log line is the
> evidence seam (identical to the ephemeral reaper's pattern).

## 5. DB carve-out: the age-gated immutability trigger

`audit_log` carries a **`BEFORE UPDATE OR DELETE` trigger**
(`trg_audit_log_immutable`). It ORIGINALLY (migration
`0003_overjoyed_sentinels.sql`) unconditionally `RAISE`d `audit_log rows are
immutable` — for **every role**, including the BYPASSRLS maintenance pool
(BYPASSRLS skips RLS **policies**, not **triggers**), so the prune's `DELETE`
was physically rejected.

This is a deliberate security control (tamper-evident append-only audit trail,
ISO 27001 A.12.4). Migration **`0060_audit_log_retention_prune_exception.sql`**
(Gate-6) replaced ONLY the trigger FUNCTION body (the trigger definition/name
are untouched) with a **tight, age-gated carve-out** — option 1 below, chosen
over the partitioning alternative for being a minimal, reversible change to the
control:

1. **Age carve-out in the trigger (shipped, 0060).** `trigger_audit_log_
immutable()` now branches three ways:
   - **UPDATE** → always `RAISE` (audit rows never change — no exception).
   - **DELETE inside the 24-month floor**
     (`OLD.created_at >= now() - interval '24 months'`) → `RAISE` (recent
     evidence is immutable and cannot be destroyed by anyone).
   - **DELETE older than the 24-month floor**
     (`OLD.created_at < now() - interval '24 months'`) → `RETURN OLD` (the
     ONLY permitted mutation — what lets the retention prune drain aged-out
     rows).
     The 24-month floor is now baked into the DB itself — a **defence-in-depth**
     guarantee INDEPENDENT of the app-level clamp in `resolveRetentionMonths`:
     even a misconfigured `AUDIT_RETENTION_MONTHS` can never make the DB delete a
     row younger than 24 months. The blocked branches keep the EXACT original
     message so `isAuditLogImmutableError` still matches.

   **Statement-level `TRUNCATE` guard (additive, 0060).** The row-level
   carve-out above is a `BEFORE UPDATE OR DELETE` trigger — it is **never
   consulted for a `TRUNCATE`**, which removes every row without firing
   row-level triggers. The BYPASSRLS owner role (`neondb_owner` / the provider
   pool) retains `TRUNCATE` privilege and could therefore have wiped the
   **entire** audit trail (including <24-month evidence) in a single statement,
   bypassing the age-gate. `0060` closes this with a **`BEFORE TRUNCATE … FOR
EACH STATEMENT`** trigger (`trg_audit_log_no_truncate`) whose function
   (`trigger_audit_log_no_truncate()`) **always** `RAISE`s
   `audit_log cannot be truncated (append-only; ISO 27001 A.12.4)`. `TRUNCATE`
   is never a legitimate operation on `audit_log` (the prune uses batched
   row-level `DELETE` only), and a `BEFORE TRUNCATE` trigger **fires even for
   the table owner**, so this closes the owner/BYPASSRLS bypass.

   **Net integrity guarantee.** `audit_log` is now protected against:
   - **`UPDATE`** — always blocked (rows never change).
   - **`DELETE` of a <24-month row** — always blocked (recent evidence).
   - **`TRUNCATE`** — always blocked, for every role including the owner.

   The **only** mutation any role can perform is a row-level `DELETE` of a row
   **older than 24 months** by the retention prune. The audit trail therefore
   **cannot be destroyed by anyone** — not even the BYPASSRLS owner — within the
   24-month forensic floor.

2. **Partitioned table + `DROP PARTITION`** (not taken). Convert `audit_log` to
   monthly range partitions on `created_at`; retention becomes `DROP TABLE`
   partition_older_than_window. Better long-term at scale, but a much larger
   migration + app impact than the surgical trigger carve-out.

Consequences now that 0060 has shipped:

- The config, the prune function, the job contract and the **daily worker
  schedule are all live and EFFECTIVE** — the prune deletes aged-out rows on
  each daily tick.
- The scheduled handler still recognises the specific immutability error and
  logs it at `warn` without throwing — a belt-and-braces guard for the
  now-impossible case where a prune ever presents an inside-floor row; in
  normal operation the `DELETE` simply succeeds and **no inside-floor row is
  ever mutated**.
- The DB spec proves the carve-out boundary is tight (UPDATE raises, recent
  DELETE raises, >24mo DELETE succeeds) and that `pruneAuditLog` deletes only
  aged-out rows in batches.

## 6. Files

| Concern                                        | File                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Config + floor clamp + batched prune           | `packages/db/src/helpers/audit-retention.ts`                                                       |
| `AUDIT_RETENTION_MONTHS` env                   | `packages/db/src/env.ts`                                                                           |
| Job contract (name / cron / strict payload)    | `packages/jobs/src/audit-retention-job.ts`                                                         |
| Worker handler + schedule                      | `apps/worker/src/handlers/audit-retention.handler.ts`, `apps/worker/src/main.ts`                   |
| Tests                                          | `packages/db/src/helpers/audit-retention.spec.ts`, `packages/jobs/src/audit-retention-job.spec.ts` |
| Immutability trigger (original blanket block)  | `packages/db/migrations/0003_overjoyed_sentinels.sql` (`trg_audit_log_immutable`)                  |
| Gate-6 age-gated carve-out (enables the prune) | `packages/db/migrations/0060_audit_log_retention_prune_exception.sql`                              |
