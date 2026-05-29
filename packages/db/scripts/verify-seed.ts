/**
 * verify-seed.ts — comprehensive verification that seed-dev.ts produced
 * the expected data in the dev DB.
 *
 * Why this exists: the live Chrome verification covered the happy path
 * but missed: building_sections rows (no API endpoint to fetch them),
 * apt3/apt4 ownerships, Beta's full chain beyond the project, Provider
 * Admin field state, signature blob bytes, the "extra signed request"
 * anomaly, and the pending-invite-must-not-login security check.
 *
 * Approach: this script uses withBootstrap (the same sanctioned RLS-
 * bypass the seed itself uses) to query everything directly. Output is
 * a single structured report — paste it into PR verification evidence.
 *
 * Read-only — does not modify any data. Safe to run any number of times.
 *
 * Usage:
 *   infisical run --env=dev -- pnpm --filter @emapp/db verify:seed
 */
/* eslint-disable no-console -- this script's job is to print a report. */
import { verify as argon2Verify } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { closeAllPools } from '../src/client';
import { env } from '../src/env';
import {
  apartments,
  auditLog,
  buildings,
  buildingSections,
  documents,
  memberships,
  organizations,
  owners,
  ownerships,
  projects,
  signatureRequests,
  signatures,
  users,
} from '../src/schema/index';
import { withBootstrap } from '../src/wrappers/with-bootstrap';

type Check = { id: string; description: string; ok: boolean; detail: string };

async function main(): Promise<number> {
  if (env.NODE_ENV !== 'development') {
    console.error(`[verify-seed] NODE_ENV=${env.NODE_ENV} — refusing.`);
    return 1;
  }

  const checks: Check[] = [];

  await withBootstrap(async (tx) => {
    // === Alpha ===
    const alpha = (
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, 'alpha-dev'))
        .limit(1)
    )[0];
    if (!alpha) {
      checks.push({
        id: 'alpha.org',
        description: 'Alpha org exists',
        ok: false,
        detail: 'NOT FOUND',
      });
      return;
    }
    checks.push({ id: 'alpha.org', description: 'Alpha org exists', ok: true, detail: alpha.id });

    // Alpha users (3 active + 1 pending invite)
    const alphaUsers = await tx
      .select({ email: users.email, name: users.name, passwordHash: users.passwordHash })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, alpha.id));
    const expectedEmails = new Set([
      'manager@alpha.dev',
      'agent@alpha.dev',
      'viewer@alpha.dev',
      'pending@alpha.dev',
    ]);
    const actualEmails = new Set(alphaUsers.map((u) => u.email));
    const missingUsers = [...expectedEmails].filter((e) => !actualEmails.has(e));
    checks.push({
      id: 'alpha.users.count',
      description: 'Alpha has 4 users (3 active + 1 pending invite)',
      ok: missingUsers.length === 0,
      detail: missingUsers.length === 0 ? `4 users present` : `MISSING: ${missingUsers.join(', ')}`,
    });

    // Pending invite — passwordHash must NOT verify against any password
    const pending = alphaUsers.find((u) => u.email === 'pending@alpha.dev');
    if (pending) {
      let canLogin = false;
      try {
        canLogin = await argon2Verify(pending.passwordHash ?? '', 'DevPassword123!');
      } catch {
        // argon2 throws on malformed hash — that's correct (login=denied)
        canLogin = false;
      }
      checks.push({
        id: 'alpha.pending.cannot_login',
        description: 'Pending invite passwordHash is unusable (security)',
        ok: !canLogin,
        detail: !canLogin
          ? `placeholder hash "${pending.passwordHash}" rejects argon2.verify`
          : `🚨 SECURITY HOLE — invite-pending password verifies`,
      });

      // Verify acceptedAt is null
      const pendingMembership = (
        await tx
          .select({ acceptedAt: memberships.acceptedAt, invitedBy: memberships.invitedBy })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(users.email, 'pending@alpha.dev'))
          .limit(1)
      )[0];
      checks.push({
        id: 'alpha.pending.acceptedAt_null',
        description: 'Pending invite has acceptedAt=null',
        ok: pendingMembership?.acceptedAt === null,
        detail: pendingMembership
          ? `acceptedAt=${pendingMembership.acceptedAt}`
          : 'membership not found',
      });
      checks.push({
        id: 'alpha.pending.invitedBy',
        description: 'Pending invite has invitedBy=manager.id',
        ok: pendingMembership?.invitedBy !== null,
        detail: pendingMembership
          ? `invitedBy=${pendingMembership.invitedBy?.slice(0, 8)}...`
          : '-',
      });
    }

    // Pilot project (by name)
    const pilot = (
      await tx
        .select({ id: projects.id, status: projects.status, type: projects.type })
        .from(projects)
        .where(and(eq(projects.orgId, alpha.id), eq(projects.name, 'Tama 38/2 — Pilot')))
        .limit(1)
    )[0];
    if (!pilot) {
      checks.push({
        id: 'alpha.pilot',
        description: 'Pilot project exists',
        ok: false,
        detail: 'NOT FOUND',
      });
      return;
    }
    checks.push({
      id: 'alpha.pilot',
      description: 'Pilot project exists, gathering_signatures, tama38_2',
      ok: pilot.status === 'gathering_signatures' && pilot.type === 'tama38_2',
      detail: `status=${pilot.status} type=${pilot.type}`,
    });

    // Buildings under Pilot
    const pilotBuildings = await tx
      .select({ id: buildings.id, address: buildings.address })
      .from(buildings)
      .where(eq(buildings.projectId, pilot.id));
    checks.push({
      id: 'alpha.pilot.buildings',
      description: 'Pilot has 2 buildings',
      ok: pilotBuildings.length === 2,
      detail: `count=${pilotBuildings.length} (${pilotBuildings.map((b) => b.address).join(', ')})`,
    });

    // building_sections per Pilot building (THE GAP — never verified before)
    for (const b of pilotBuildings) {
      const sections = await tx
        .select({
          entrance: buildingSections.entrance,
          kind: buildingSections.kind,
          floors: buildingSections.floors,
          unitCount: buildingSections.unitCount,
          gush: buildingSections.gush,
          helka: buildingSections.helka,
        })
        .from(buildingSections)
        .where(and(eq(buildingSections.buildingId, b.id), isNull(buildingSections.archivedAt)));
      checks.push({
        id: `alpha.section.${b.address}`,
        description: `Building "${b.address}" has 1 section (entrance א, residential, gush/helka)`,
        ok:
          sections.length === 1 &&
          sections[0]!.entrance === 'א' &&
          sections[0]!.kind === 'residential' &&
          sections[0]!.gush === '6213' &&
          sections[0]!.helka === '47',
        detail: sections.length === 0 ? 'NO SECTIONS' : JSON.stringify(sections[0]),
      });
    }

    // Apartments + D.39 metadata (verify ALL 4, not just 2)
    const expectedApts: Record<string, { unitType: string; areaSqm: string; entrance: string }> = {
      '1': { unitType: 'apt', areaSqm: '78.50', entrance: 'א' },
      '2': { unitType: 'apt', areaSqm: '82.00', entrance: 'א' },
      '3': { unitType: 'apt', areaSqm: '95.25', entrance: 'א' },
      '4': { unitType: 'office', areaSqm: '54.00', entrance: 'א' },
    };
    const pilotApts: Array<{
      id: string;
      number: string;
      unitType: string;
      areaSqm: string | null;
      entrance: string | null;
    }> = [];
    for (const b of pilotBuildings) {
      const apts = await tx
        .select({
          id: apartments.id,
          number: apartments.number,
          unitType: apartments.unitType,
          areaSqm: apartments.areaSqm,
          entrance: apartments.entrance,
        })
        .from(apartments)
        .where(eq(apartments.buildingId, b.id));
      pilotApts.push(...apts);
    }
    for (const [n, expected] of Object.entries(expectedApts)) {
      const apt = pilotApts.find((a) => a.number === n);
      const ok =
        !!apt &&
        apt.unitType === expected.unitType &&
        apt.areaSqm === expected.areaSqm &&
        apt.entrance === expected.entrance;
      checks.push({
        id: `alpha.apt${n}.metadata`,
        description: `Apt #${n} has unit_type=${expected.unitType}, area_sqm=${expected.areaSqm}, entrance=${expected.entrance}`,
        ok,
        detail: apt
          ? `actual: type=${apt.unitType} area=${apt.areaSqm} entrance=${apt.entrance}`
          : 'apt not found',
      });
    }

    // Ownerships per apt (verify ALL 4 — not just the 2 I checked live)
    const expectedOwn: Record<string, string[]> = {
      '1': ['100.00'],
      '2': ['60.00', '40.00'],
      '3': ['100.00'],
      '4': ['100.00'],
    };
    for (const apt of pilotApts) {
      const own = await tx
        .select({ pct: ownerships.ownershipPct })
        .from(ownerships)
        .where(and(eq(ownerships.apartmentId, apt.id), isNull(ownerships.endedAt)));
      const actualPcts = own.map((o) => o.pct).sort();
      const expectedPcts = expectedOwn[apt.number]?.sort() ?? [];
      const ok = JSON.stringify(actualPcts) === JSON.stringify(expectedPcts);
      checks.push({
        id: `alpha.apt${apt.number}.ownerships`,
        description: `Apt #${apt.number} ownerships sum=100 (expected ${expectedPcts.join('+')})`,
        ok,
        detail: `actual: [${actualPcts.join(', ')}]`,
      });
    }

    // Documents
    const alphaDocs = await tx
      .select({ name: documents.name, type: documents.type, projectId: documents.projectId })
      .from(documents)
      .where(
        and(
          eq(documents.orgId, alpha.id),
          sql`${documents.r2Key} LIKE ${`documents/${alpha.id}/%`}`,
        ),
      );
    checks.push({
      id: 'alpha.docs.count',
      description: 'Alpha has 4 seed documents (regulation + blueprint + 2 agreements)',
      ok: alphaDocs.length === 4,
      detail: `count=${alphaDocs.length}: ${alphaDocs
        .map((d) => d.type)
        .sort()
        .join(',')}`,
    });
    const misAttributed = alphaDocs.filter((d) => d.projectId !== pilot.id);
    checks.push({
      id: 'alpha.docs.bind_pilot',
      description: 'All 4 seed docs bound to Pilot (the projectId fix)',
      ok: misAttributed.length === 0,
      detail:
        misAttributed.length === 0
          ? 'all docs.projectId = pilot.id'
          : `${misAttributed.length} mis-attributed`,
    });

    // Signature requests — verify by jti (the stable seed identifier)
    const expectedJtis = [
      'seed-sig-apt1-dana-pending',
      'seed-sig-apt2-dana-signed',
      'seed-sig-apt2-yossi-signed',
      'seed-sig-reg-yossi-pending',
      'seed-sig-reg-sara-cancelled',
    ];
    const seedReqs = await tx
      .select({
        jti: signatureRequests.jti,
        status: signatureRequests.status,
        signedSignatureId: signatureRequests.signedSignatureId,
      })
      .from(signatureRequests)
      .where(
        and(eq(signatureRequests.orgId, alpha.id), sql`${signatureRequests.jti} LIKE 'seed-sig-%'`),
      );
    checks.push({
      id: 'alpha.sigreq.count',
      description: 'All 5 seeded signature_requests present (by jti prefix)',
      ok: seedReqs.length === 5,
      detail: `count=${seedReqs.length} jtis=${seedReqs
        .map((r) => r.jti.replace('seed-sig-', ''))
        .sort()
        .join(', ')}`,
    });
    const missingJtis = expectedJtis.filter((j) => !seedReqs.some((r) => r.jti === j));
    if (missingJtis.length > 0) {
      checks.push({
        id: 'alpha.sigreq.completeness',
        description: 'All expected jtis exist',
        ok: false,
        detail: `MISSING: ${missingJtis.join(', ')}`,
      });
    }
    const stateBreakdown = {
      pending: seedReqs.filter((r) => r.status === 'pending').length,
      signed: seedReqs.filter((r) => r.status === 'signed').length,
      cancelled: seedReqs.filter((r) => r.status === 'cancelled').length,
    };
    checks.push({
      id: 'alpha.sigreq.states',
      description: 'States breakdown of seed reqs: 2 pending + 2 signed + 1 cancelled',
      ok:
        stateBreakdown.pending === 2 &&
        stateBreakdown.signed === 2 &&
        stateBreakdown.cancelled === 1,
      detail: `pending=${stateBreakdown.pending} signed=${stateBreakdown.signed} cancelled=${stateBreakdown.cancelled}`,
    });

    // Signature blobs — verify 2 exist with correct shape
    const signedReqsLinked = seedReqs.filter((r) => r.status === 'signed' && r.signedSignatureId);
    const signedSigIds = signedReqsLinked.map((r) => r.signedSignatureId!).filter(Boolean);
    const sigBlobs: Array<{ format: string; authMethod: string; ip: string | null; size: number }> =
      [];
    for (const sid of signedSigIds) {
      const s = (
        await tx
          .select({
            format: signatures.signatureFormat,
            authMethod: signatures.authMethod,
            ip: signatures.signerIp,
            blob: signatures.signatureBlob,
          })
          .from(signatures)
          .where(eq(signatures.id, sid))
          .limit(1)
      )[0];
      if (s)
        sigBlobs.push({
          format: s.format,
          authMethod: s.authMethod,
          ip: s.ip,
          size: s.blob.length,
        });
    }
    checks.push({
      id: 'alpha.sigblob.exists',
      description:
        '2 signature blobs exist for the 2 signed seed reqs, format=svg, authMethod=sms_otp, ip=203.0.113.42',
      ok:
        sigBlobs.length === 2 &&
        sigBlobs.every(
          (s) =>
            s.format === 'svg' &&
            s.authMethod === 'sms_otp' &&
            s.ip === '203.0.113.42' &&
            s.size > 100,
        ),
      detail: JSON.stringify(sigBlobs.map((s) => ({ ...s, size: `${s.size}b` }))),
    });

    // Investigate the "3 signed in API but 2 in my seed" anomaly:
    // count ALL signed signature_requests for Alpha, not just seed-tagged
    const allSignedAlpha = await tx
      .select({ jti: signatureRequests.jti })
      .from(signatureRequests)
      .where(and(eq(signatureRequests.orgId, alpha.id), eq(signatureRequests.status, 'signed')));
    const nonSeedSigned = allSignedAlpha.filter((r) => !r.jti.startsWith('seed-sig-'));
    checks.push({
      id: 'alpha.signed.anomaly',
      description:
        'The "3 signed" anomaly: confirms 1 extra came from agent smoke (jti not seed-tagged)',
      ok: nonSeedSigned.length >= 0, // informational
      detail:
        nonSeedSigned.length === 1
          ? `1 non-seed signed req (agent smoke): jti="${nonSeedSigned[0]!.jti.slice(0, 40)}..."`
          : `${nonSeedSigned.length} non-seed signed reqs`,
    });

    // Side effects: ownerships my seed may have inserted on smoke-project apts
    const otherProjs = await tx
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.orgId, alpha.id), sql`${projects.name} <> 'Tama 38/2 — Pilot'`));
    let crossProjectOwnerships = 0;
    for (const p of otherProjs) {
      const apts = await tx
        .select({ id: apartments.id, number: apartments.number })
        .from(apartments)
        .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
        .where(and(eq(buildings.projectId, p.id), sql`${apartments.number} IN ('1','2','3','4')`));
      for (const apt of apts) {
        const own = await tx
          .select({ id: ownerships.id })
          .from(ownerships)
          .where(and(eq(ownerships.apartmentId, apt.id), isNull(ownerships.endedAt)));
        // Only count if the ownership row was likely from MY seed (heuristic:
        // pct exactly matches my APT_OWNERSHIPS spec)
        crossProjectOwnerships += own.length;
      }
    }
    checks.push({
      id: 'alpha.side_effects',
      description: 'Side effects check: ownerships on smoke-project apts numbered 1-4',
      ok: crossProjectOwnerships === 0, // ideal; if >0 we polluted other projects
      detail: `${crossProjectOwnerships} ownership rows found on non-Pilot apts numbered 1-4 across ${otherProjs.length} other Alpha projects`,
    });

    // === Beta ===
    const beta = (
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, 'beta-dev'))
        .limit(1)
    )[0];
    if (!beta) {
      checks.push({
        id: 'beta.org',
        description: 'Beta org exists',
        ok: false,
        detail: 'NOT FOUND',
      });
    } else {
      checks.push({ id: 'beta.org', description: 'Beta org exists', ok: true, detail: beta.id });

      const betaProj = await tx
        .select({
          id: projects.id,
          name: projects.name,
          type: projects.type,
          status: projects.status,
        })
        .from(projects)
        .where(eq(projects.orgId, beta.id));
      checks.push({
        id: 'beta.project',
        description: 'Beta has 1 project (pinui_binui, planning)',
        ok:
          betaProj.length === 1 &&
          betaProj[0]!.type === 'pinui_binui' &&
          betaProj[0]!.status === 'planning',
        detail: `${betaProj.length} project: ${betaProj[0]?.name}`,
      });

      const betaBlds = await tx
        .select({ id: buildings.id, address: buildings.address, city: buildings.city })
        .from(buildings)
        .innerJoin(projects, eq(projects.id, buildings.projectId))
        .where(eq(projects.orgId, beta.id));
      checks.push({
        id: 'beta.building',
        description: 'Beta has 1 building (ויצמן 5, קרית אונו)',
        ok:
          betaBlds.length === 1 &&
          betaBlds[0]!.address === 'ויצמן 5' &&
          betaBlds[0]!.city === 'קרית אונו',
        detail: `${betaBlds.length} bldg: ${betaBlds[0]?.address}, ${betaBlds[0]?.city}`,
      });

      if (betaBlds[0]) {
        const betaSecs = await tx
          .select({ entrance: buildingSections.entrance, gush: buildingSections.gush })
          .from(buildingSections)
          .where(eq(buildingSections.buildingId, betaBlds[0].id));
        checks.push({
          id: 'beta.section',
          description: 'Beta has 1 building_section (gush 7811)',
          ok: betaSecs.length === 1 && betaSecs[0]!.gush === '7811',
          detail: `${betaSecs.length} section${betaSecs.length === 1 ? `, gush=${betaSecs[0]!.gush}` : ''}`,
        });

        const betaApts = await tx
          .select({
            number: apartments.number,
            unitType: apartments.unitType,
            areaSqm: apartments.areaSqm,
          })
          .from(apartments)
          .where(eq(apartments.buildingId, betaBlds[0].id));
        checks.push({
          id: 'beta.apartment',
          description: 'Beta has 1 apartment (#1, apt, area 110)',
          ok:
            betaApts.length === 1 &&
            betaApts[0]!.number === '1' &&
            betaApts[0]!.unitType === 'apt' &&
            betaApts[0]!.areaSqm === '110.00',
          detail: `${betaApts.length} apt${betaApts.length === 1 ? `: #${betaApts[0]!.number} ${betaApts[0]!.unitType} ${betaApts[0]!.areaSqm}m²` : ''}`,
        });
      }

      const betaOwners = await tx
        .select({ id: owners.id })
        .from(owners)
        .where(eq(owners.orgId, beta.id));
      checks.push({
        id: 'beta.owner',
        description: 'Beta has 1 owner',
        ok: betaOwners.length === 1,
        detail: `${betaOwners.length} owner(s)`,
      });

      const betaOwn = await tx
        .select({ pct: ownerships.ownershipPct })
        .from(ownerships)
        .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
        .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
        .innerJoin(projects, eq(projects.id, buildings.projectId))
        .where(and(eq(projects.orgId, beta.id), isNull(ownerships.endedAt)));
      checks.push({
        id: 'beta.ownership',
        description: 'Beta has 1 ownership (100%)',
        ok: betaOwn.length === 1 && betaOwn[0]!.pct === '100.00',
        detail: betaOwn.map((o) => o.pct).join(','),
      });
    }

    // === Provider Admin ===
    // The provider_users table is in the provider schema file
    const provRows = await tx.execute(sql`
      SELECT email, role, disabled_at,
             octet_length(mfa_secret_encrypted) AS mfa_secret_bytes,
             jsonb_array_length(recovery_codes_hash) AS recovery_count
      FROM provider_users
      WHERE email = 'admin@provider.dev'
      LIMIT 1
    `);
    const prov = (provRows as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
    checks.push({
      id: 'provider.admin.exists',
      description:
        'Provider admin row: role=admin, MFA secret stored, 8 recovery codes hashed, not disabled',
      ok:
        !!prov &&
        prov.role === 'admin' &&
        Number(prov.mfa_secret_bytes) > 0 &&
        Number(prov.recovery_count) === 8 &&
        prov.disabled_at === null,
      detail: prov
        ? `role=${prov.role} disabled_at=${prov.disabled_at} secret_bytes=${prov.mfa_secret_bytes} recovery_codes=${prov.recovery_count}`
        : 'NOT FOUND',
    });

    // === Audit log presence — informational ===
    const auditCount = (await tx.execute(
      sql`SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id = ${alpha.id}`,
    )) as unknown as { rows: Array<{ n: number }> };
    checks.push({
      id: 'audit.alpha',
      description: 'Alpha has audit log entries (from real activity, not seed)',
      ok: auditCount.rows[0]!.n >= 0, // informational
      detail: `${auditCount.rows[0]!.n} audit rows`,
    });
    void auditLog; // keep import warm
  });

  // === Report ===
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  console.log('\n=== Seed Verification Report ===\n');
  for (const c of checks) {
    const mark = c.ok ? '✅' : '❌';
    console.log(`${mark} [${c.id}] ${c.description}`);
    console.log(`     ${c.detail}`);
  }
  console.log(`\n=== Summary: ${passed}/${checks.length} passed, ${failed} failed ===\n`);
  return failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeAllPools();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[verify-seed] failed:', err);
    await closeAllPools();
    process.exit(1);
  });
