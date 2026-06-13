/**
 * Static integrity guard for the Drizzle migration journal
 * (`migrations/meta/_journal.json`).
 *
 * WHY THIS EXISTS — the silent-skip footgun.
 * The node-postgres migrator (drizzle-orm 0.45, verified from source) applies
 * a journal entry iff `entry.when > lastDbMigration.created_at`, where
 * `lastDbMigration` is the single MAX(created_at) snapshot taken ONCE before
 * the apply loop and never advanced in-loop:
 *
 *   const lastDbMigration = (… order by created_at desc limit 1)[0];
 *   for (const m of migrations)
 *     if (!lastDbMigration || Number(lastDbMigration.created_at) < m.folderMillis) apply(m);
 *
 * Consequences:
 *  - On a FRESH db (`lastDbMigration` undefined) every entry applies, in idx
 *    order, regardless of `when` ordering — so historical non-monotonicity is
 *    harmless on fresh installs.
 *  - On an EXISTING db at watermark W, every entry with `when <= W` is SILENTLY
 *    skipped (`migrate.ts` still logs "applied successfully").
 *
 * This team HAND-AUTHORS migrations + their `_journal.json` entries (see
 * packages/db/CLAUDE.md). The recurring footgun: a hand-authored entry whose
 * `when` is <= the prior max (copy-pasted timestamp, a stale branch-point
 * millis) makes the entry non-monotonic at the tip. The moment it reaches a db
 * already at the previous tip's watermark, the migrator skips it → schema
 * drift that no error surfaces. `checkJournalIntegrity` fails CI at PR time
 * when that invariant is broken.
 *
 * SCOPE / HONESTY. This is the STATIC half. It does NOT detect the *runtime*
 * drift of finding M-1 (a shared dev db whose watermark was lifted above an
 * unmerged migration by sibling branches) — that requires reading the live
 * `__drizzle_migrations` table. `findUnappliedMigrations` is the pure primitive
 * for that runtime reconciliation; wiring it against a real staging/prod db at
 * deploy/boot remains the owner-side step (see the M-1 memory).
 */

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export type JournalViolationKind =
  | 'idx_not_position'
  | 'duplicate_tag'
  | 'missing_sql_file'
  | 'when_not_increasing';

export interface JournalViolation {
  kind: JournalViolationKind;
  idx: number;
  tag: string;
  detail: string;
}

/**
 * Tags whose `when` predates this invariant and are intentionally exempt from
 * the strictly-increasing check. There are exactly two known historical
 * inversions, both in one ancient cluster: `0005_composite_indexes` carries a
 * suspiciously round, hand-edited `when` (1779031200000) that forms a local
 * peak, and the two drizzle-generated entries right after it fall below that
 * peak — `0006_cool_roulette` (1779030536556) and `0007_warm_owl`
 * (1779031022226). From `0008` onward (1779031800000) the journal is strictly
 * increasing. Both are benign: they predate this guard, are far below every
 * later watermark, and on a fresh db the migrator applies all entries
 * regardless of `when` order. Do NOT add to this set to "make CI pass" a new
 * migration: pick a `when` strictly greater than the current tip instead.
 * Rewriting an already-applied entry's `when` is the dangerous move (it would
 * re-apply on dbs past it), which is exactly why these are grandfathered
 * rather than retro-fixed.
 */
const GRANDFATHERED_WHEN_INVERSIONS: ReadonlySet<string> = new Set([
  '0006_cool_roulette',
  '0007_warm_owl',
]);

/**
 * Validate the journal against the silent-skip invariants. Pure: filesystem
 * access is injected via `sqlFileExists` so the function is unit-testable with
 * synthetic journals. Returns every violation found (empty array = healthy).
 */
export function checkJournalIntegrity(
  journal: Journal,
  sqlFileExists: (tag: string) => boolean,
): JournalViolation[] {
  const violations: JournalViolation[] = [];
  const entries = journal.entries ?? [];
  const seenTags = new Set<string>();
  let runningMaxWhen = Number.NEGATIVE_INFINITY;

  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position];
    if (!entry) continue;

    // 1) idx must equal array position — catches a gap, a duplicate idx, or an
    //    out-of-order journal that would make the apply order ambiguous.
    if (entry.idx !== position) {
      violations.push({
        kind: 'idx_not_position',
        idx: entry.idx,
        tag: entry.tag,
        detail: `entry at position ${position} has idx ${entry.idx}; idx must equal position`,
      });
    }

    // 2) tags must be unique — a duplicate tag means two entries point at the
    //    same .sql, or a copy-paste left a stale tag.
    if (seenTags.has(entry.tag)) {
      violations.push({
        kind: 'duplicate_tag',
        idx: entry.idx,
        tag: entry.tag,
        detail: `tag "${entry.tag}" appears more than once`,
      });
    }
    seenTags.add(entry.tag);

    // 3) every journal entry must have its .sql file on disk — a missing file
    //    makes readMigrationFiles throw at migrate time; catch it statically.
    if (!sqlFileExists(entry.tag)) {
      violations.push({
        kind: 'missing_sql_file',
        idx: entry.idx,
        tag: entry.tag,
        detail: `no SQL file found for tag "${entry.tag}"`,
      });
    }

    // 4) the silent-skip guard — `when` must strictly exceed the running max of
    //    all prior entries, except the grandfathered historical inversion.
    if (entry.when <= runningMaxWhen && !GRANDFATHERED_WHEN_INVERSIONS.has(entry.tag)) {
      violations.push({
        kind: 'when_not_increasing',
        idx: entry.idx,
        tag: entry.tag,
        detail:
          `when ${entry.when} is <= the running max ${runningMaxWhen} of prior entries; ` +
          'the migrator would silently skip this migration on a db already at the prior watermark. ' +
          'Pick a `when` strictly greater than the current tip.',
      });
    }
    if (entry.when > runningMaxWhen) runningMaxWhen = entry.when;
  }

  return violations;
}

/**
 * Pure reconciliation primitive for the M-1 *runtime* half. Given the journal
 * entries and the `created_at` values currently recorded in
 * `__drizzle_migrations`, return the entries that have NOT been applied.
 *
 * Mapping is by `when` === `created_at`: the migrator inserts each applied
 * migration with `created_at = entry.when`, and `checkJournalIntegrity`
 * guarantees `when`s are unique, so a `when` present in `appliedCreatedAt`
 * uniquely identifies an applied entry. A deploy/boot guard calls this with
 * the live `SELECT created_at FROM drizzle.__drizzle_migrations` and fails if
 * the result is non-empty.
 */
export function findUnappliedMigrations(
  entries: readonly Pick<JournalEntry, 'tag' | 'when'>[],
  appliedCreatedAt: readonly (number | string)[],
): { tag: string; when: number }[] {
  const applied = new Set<number>(appliedCreatedAt.map((c) => Number(c)));
  return entries
    .filter((e) => !applied.has(Number(e.when)))
    .map((e) => ({ tag: e.tag, when: e.when }));
}
