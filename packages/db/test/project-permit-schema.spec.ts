/**
 * wave-2.4 future-states — migration 0083 (building-permit tracking) schema
 * acceptance. Proves the migration applied: the new `permit_status` enum type
 * exists with the expected values, and `projects` carries the three new columns
 * with the correct types + default. DB-level (providerDb / information_schema).
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/db exec \
 *     vitest run test/project-permit-schema.spec.ts
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { providerDb } from '../src/index';

describe('migration 0083 — projects permit columns', () => {
  it('the permit_status enum exists with the expected closed set', async () => {
    const res = await providerDb.execute(sql`
      SELECT e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'permit_status'
      ORDER BY e.enumsortorder
    `);
    const labels = (res as unknown as { rows: Array<{ label: string }> }).rows.map((r) => r.label);
    expect(labels).toEqual(['none', 'applied', 'approved', 'rejected', 'expired']);
  });

  it('projects has permit_status NOT NULL default none + two nullable timestamptz columns', async () => {
    const res = await providerDb.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default, udt_name
      FROM information_schema.columns
      WHERE table_name = 'projects'
        AND column_name IN ('permit_status', 'permit_applied_at', 'permit_expiry_at')
      ORDER BY column_name
    `);
    const rows = (
      res as unknown as {
        rows: Array<{
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
          udt_name: string;
        }>;
      }
    ).rows;
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

    expect(byName['permit_status']).toBeDefined();
    expect(byName['permit_status']!.udt_name).toBe('permit_status');
    expect(byName['permit_status']!.is_nullable).toBe('NO');
    expect(byName['permit_status']!.column_default ?? '').toContain("'none'");

    expect(byName['permit_applied_at']).toBeDefined();
    expect(byName['permit_applied_at']!.data_type).toBe('timestamp with time zone');
    expect(byName['permit_applied_at']!.is_nullable).toBe('YES');

    expect(byName['permit_expiry_at']).toBeDefined();
    expect(byName['permit_expiry_at']!.data_type).toBe('timestamp with time zone');
    expect(byName['permit_expiry_at']!.is_nullable).toBe('YES');
  });
});
