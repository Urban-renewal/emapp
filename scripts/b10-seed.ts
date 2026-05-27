/**
 * V11 B.S10 smoke seeder — creates a project + 2 buildings + 3 apartments
 * + 3 owners + 4 ownerships via withTenant (respects RLS), then prints
 * the project id for the curl smoke to consume.
 *
 * Usage: ORG_ID=… USER_ID=… pnpm tsx scripts/b10-seed.ts
 */
/* eslint-disable no-console */
import {
  apartments,
  buildings,
  encryptOwnerPii,
  owners,
  ownerships,
  projects,
  withTenant,
} from '../packages/db/src';

const ORG = process.env['ORG_ID']!;
const USER = process.env['USER_ID']!;

async function main(): Promise<void> {
  const result = await withTenant(ORG, async (tx) => {
    // Project
    const [project] = await tx
      .insert(projects)
      .values({
        orgId: ORG,
        name: 'דיזנגוף 100 — תמ"א 38',
        type: 'tama38_1',
        description:
          'B.S10 smoke seed — Hebrew project name to test RTL + Heebo + RFC 5987 filename',
        createdBy: USER,
      })
      .returning({ id: projects.id });
    if (!project) throw new Error('project insert failed');

    // Building 1 (Dizengoff 100) + Building 2 (empty for gap testing)
    const [b1] = await tx
      .insert(buildings)
      .values({
        projectId: project.id,
        address: 'דיזנגוף 100',
        city: 'תל אביב',
        block: '7104',
        parcel: '42',
      })
      .returning({ id: buildings.id });
    const [b2] = await tx
      .insert(buildings)
      .values({
        projectId: project.id,
        address: 'דיזנגוף 102 (ריק)',
        city: 'תל אביב',
      })
      .returning({ id: buildings.id });
    if (!b1 || !b2) throw new Error('building insert failed');

    // Apartments — apt1 (will have 2 owners), apt2 (will have 1 owner),
    // apt3 (will have ZERO owners — exercise the gap row in the renderer).
    const [a1] = await tx
      .insert(apartments)
      .values({
        buildingId: b1.id,
        number: '1',
        floor: 1,
        sizeSqm: '85',
        rooms: '3.5',
        unitType: 'apt',
        entrance: 'א',
      })
      .returning({ id: apartments.id });
    const [a2] = await tx
      .insert(apartments)
      .values({
        buildingId: b1.id,
        number: '2',
        floor: 1,
        sizeSqm: '95',
        rooms: '4',
        unitType: 'shop',
        entrance: 'א',
      })
      .returning({ id: apartments.id });
    const [a3] = await tx
      .insert(apartments)
      .values({
        buildingId: b1.id,
        number: '3',
        floor: 2,
        sizeSqm: '110',
        rooms: '4.5',
        unitType: 'apt',
        entrance: 'א',
      })
      .returning({ id: apartments.id });
    if (!a1 || !a2 || !a3) throw new Error('apartment insert failed');

    // Owners
    const makeOwner = async (name: string, nid: string, phone: string, email: string) => {
      const enc = await encryptOwnerPii(tx as unknown as Parameters<typeof encryptOwnerPii>[0], {
        name,
        nationalId: nid,
        phone,
      });
      const [row] = await tx
        .insert(owners)
        .values({
          orgId: ORG,
          nameEncrypted: enc.nameEncrypted,
          nameHash: enc.nameHash,
          nationalIdEncrypted: enc.nationalIdEncrypted,
          nationalIdHash: enc.nationalIdHash,
          phoneEncrypted: enc.phoneEncrypted,
          phoneHash: enc.phoneHash,
          email,
        })
        .returning({ id: owners.id });
      if (!row) throw new Error(`owner insert failed for ${name}`);
      return row.id;
    };
    const o1 = await makeOwner('דוד כהן', '000000018', '0501234567', 'david@example.com');
    const o2 = await makeOwner('שרה כהן', '000000026', '0507654321', 'sara@example.com');
    const o3 = await makeOwner('משה לוי', '000000034', '0501112233', 'moshe@example.com');

    // Ownerships: apt1 = david(50) + sara(50), apt2 = moshe(100). apt3 = none (gap).
    await tx.insert(ownerships).values([
      { apartmentId: a1.id, ownerId: o1, ownershipPct: '50', role: 'owner' },
      { apartmentId: a1.id, ownerId: o2, ownershipPct: '50', role: 'owner' },
    ]);
    await tx.insert(ownerships).values({
      apartmentId: a2.id,
      ownerId: o3,
      ownershipPct: '100',
      role: 'owner',
    });

    return { projectId: project.id };
  });
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
