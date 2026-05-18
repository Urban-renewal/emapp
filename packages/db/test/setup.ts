// Migrations are applied ONCE by the vitest globalSetup (./global-setup.ts)
// before any worker starts. Per-suite migrate() in parallel workers caused a
// concurrent-DDL race that flaked CI on every new migration. This is now a
// no-op kept only so the many suites that call it still compile; the schema
// is guaranteed present by the time any test runs.
export async function setupTestDatabase(): Promise<void> {
  /* schema already migrated by global-setup.ts — intentionally a no-op */
}
