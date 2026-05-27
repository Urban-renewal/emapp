/**
 * V11 B.S8 smoke runner — Project → xlsx export.
 *
 * Produces a real .xlsx file on disk so the partner can open it in
 * Excel/LibreOffice/Numbers and visually confirm:
 *   - RTL layout (column A on the right)
 *   - Hebrew header row in Heebo
 *   - Hebrew unit_type + status labels
 *   - Metadata rows + frozen header
 *
 * No DB access — runs the pure-function service against a fixture
 * that mimics one Tel Aviv building with 3 apartments + 5 owners.
 *
 * Usage:  pnpm tsx scripts/b8-smoke.ts <out-path>
 */
/* eslint-disable no-console */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ExportService,
  type ProjectExportInput,
} from '../apps/api/src/modules/export/export.service';

const out = resolve(process.argv[2] ?? './b8-smoke.xlsx');
const svc = new ExportService();

const input: ProjectExportInput = {
  project: {
    id: 'demo-proj',
    name: 'דיזנגוף 100 — תמ"א 38',
    type: 'tama38_1',
    status: 'gathering_signatures',
  },
  generatedAt: new Date('2026-05-27T12:00:00Z'),
  generatedBy: { name: 'B.S8 Manager', email: 'mgr@example.com' },
  buildings: [
    {
      id: 'b1',
      address: 'דיזנגוף 100',
      city: 'תל אביב',
      block: '7104',
      parcel: '42',
      apartments: [
        {
          id: 'a1',
          number: '1',
          floor: 1,
          sizeSqm: 85,
          rooms: 3.5,
          status: 'signed',
          unitType: 'apt',
          areaSqm: null,
          entrance: 'א',
          owners: [
            {
              name: 'דוד כהן',
              nationalId: '000000018',
              phone: '0501234567',
              email: 'david@example.com',
              ownershipPct: 50,
            },
            {
              name: 'שרה כהן',
              nationalId: '000000026',
              phone: '0507654321',
              email: 'sara@example.com',
              ownershipPct: 50,
            },
          ],
        },
        {
          id: 'a2',
          number: '2',
          floor: 1,
          sizeSqm: 95,
          rooms: 4,
          status: 'pending',
          unitType: 'shop',
          areaSqm: null,
          entrance: 'א',
          owners: [
            {
              name: 'משה לוי',
              nationalId: '000000034',
              phone: '0501112233',
              email: 'moshe@example.com',
              ownershipPct: 100,
            },
          ],
        },
        {
          id: 'a3',
          number: '3',
          floor: 2,
          sizeSqm: 110,
          rooms: 4.5,
          status: 'declined',
          unitType: 'apt',
          areaSqm: null,
          entrance: 'א',
          owners: [],
        },
      ],
    },
  ],
};

(async () => {
  const t0 = Date.now();
  const buf = await svc.renderProjectXlsx(input);
  writeFileSync(out, buf);
  console.log(
    JSON.stringify({
      path: out,
      bytes: buf.byteLength,
      elapsedMs: Date.now() - t0,
      // First 4 bytes of a valid .xlsx (== first 4 bytes of any zip):
      // 50 4B 03 04 (P K \x03 \x04). Print as hex for the smoke log.
      magic: Array.from(buf.subarray(0, 4))
        .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' '),
    }),
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
