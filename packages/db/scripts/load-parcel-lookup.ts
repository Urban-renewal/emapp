/* eslint-disable no-console -- operational loader; stdout IS the UX (repo scripts convention). */
/**
 * load-parcel-lookup — P3b bulk loader for the GLOBAL `parcel_lookup`
 * reference table (docs/DESIGN-phase3-parcel-autosetup.md §6 P3b; migration
 * 0074). Ingests a `block,parcel,sub,city,lat,lng`-headed CSV (the bulk-מפ"י
 * open-data parcels export, normalized) and UPSERTs it in batches — re-running
 * the same file is IDEMPOTENT (the conflict target is the
 * parcel_lookup_block_parcel_sub_key UNIQUE NULLS NOT DISTINCT constraint, so
 * NULL-sub rows dedupe too). Monthly refresh = just run it again.
 *
 * Runs on the OWNER-role pool (providerPool): app_user is deliberately
 * SELECT-only on parcel_lookup (0074) — the app never writes national
 * reference data; this script is the ONLY write path.
 *
 * SECURITY: every value is bound as a query PARAMETER ($n) — nothing from the
 * CSV is ever interpolated into SQL. The data itself is a public national
 * record (no PII, no tenant data).
 *
 * IMPORT-SAFE: importing this module has NO side effects (no top-level run —
 * the CLI entry below only fires when executed directly, the repo's standard
 * audit-forge-otp guard).
 *
 * CLI:
 *   infisical run --env=dev -- pnpm --filter @emapp/db exec \
 *     tsx scripts/load-parcel-lookup.ts <path/to/parcels.csv>
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { closeAllPools, providerPool } from '../src/client';

const EXPECTED_HEADER = ['block', 'parcel', 'sub', 'city', 'lat', 'lng'] as const;
const BATCH_SIZE = 1000; // 6 params/row — far below the 65535 PG bind limit.

interface ParsedRow {
  block: string;
  parcel: string;
  sub: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
}

function parseNumber(raw: string, line: number, field: string): number | null {
  if (raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`load-parcel-lookup: line ${line}: invalid ${field} (not a finite number)`);
  }
  return n;
}

/** Parse the controlled `block,parcel,sub,city,lat,lng` CSV (no quoted commas
 *  in the normalized export; blank lines skipped; empty cell = NULL). */
function parseCsv(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/);
  const headerLine = lines[0]?.trim();
  const header = headerLine?.split(',').map((h) => h.trim());
  if (!header || header.join(',') !== EXPECTED_HEADER.join(',')) {
    throw new Error(
      `load-parcel-lookup: bad CSV header — expected "${EXPECTED_HEADER.join(',')}", got "${headerLine ?? ''}"`,
    );
  }
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue; // blank / trailing newline
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== EXPECTED_HEADER.length) {
      throw new Error(
        `load-parcel-lookup: line ${i + 1}: expected ${EXPECTED_HEADER.length} cells, got ${cells.length}`,
      );
    }
    const [block, parcel, sub, city, lat, lng] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!block || !parcel) {
      throw new Error(`load-parcel-lookup: line ${i + 1}: block/parcel are required`);
    }
    rows.push({
      block,
      parcel,
      sub: sub === '' ? null : sub,
      city: city === '' ? null : city,
      lat: parseNumber(lat, i + 1, 'lat'),
      lng: parseNumber(lng, i + 1, 'lng'),
    });
  }
  return rows;
}

/**
 * Load (UPSERT) a parcel-lookup CSV into `parcel_lookup`. Idempotent: the
 * conflict target is the UNIQUE NULLS NOT DISTINCT (block, parcel, sub)
 * constraint, so re-loading the same file (including its NULL-sub rows)
 * updates in place instead of duplicating. One transaction — all or nothing.
 */
export async function loadParcelLookup(csvPath: string): Promise<{ rowsLoaded: number }> {
  const rows = parseCsv(await readFile(csvPath, 'utf8'));
  const client = await providerPool.connect();
  try {
    await client.query('BEGIN');
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const batch = rows.slice(start, start + BATCH_SIZE);
      const params: Array<string | number | null> = [];
      const tuples = batch.map((r, i) => {
        params.push(r.block, r.parcel, r.sub, r.city, r.lat, r.lng);
        const base = i * 6;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      });
      // Parameterized batch UPSERT — values are ONLY ever bound, never inlined.
      await client.query(
        `INSERT INTO parcel_lookup
           (block_number, parcel_number, sub_parcel, city, centroid_lat, centroid_lng)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (block_number, parcel_number, sub_parcel)
         DO UPDATE SET
           city = EXCLUDED.city,
           centroid_lat = EXCLUDED.centroid_lat,
           centroid_lng = EXCLUDED.centroid_lng`,
        params,
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { rowsLoaded: rows.length };
}

// ── CLI entry (guarded — importing this module runs NOTHING) ────────────────
const isCli =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const csvPath = process.argv[2];
  (async () => {
    if (!csvPath) throw new Error('usage: tsx scripts/load-parcel-lookup.ts <parcels.csv>');
    const { rowsLoaded } = await loadParcelLookup(csvPath);
    console.log(`parcel_lookup: upserted ${rowsLoaded} rows from ${csvPath}`);
  })()
    .then(async () => {
      await closeAllPools();
      process.exit(0);
    })
    .catch(async (e: unknown) => {
      console.error('ERR', e instanceof Error ? e.message : String(e));
      await closeAllPools();
      process.exit(1);
    });
}
