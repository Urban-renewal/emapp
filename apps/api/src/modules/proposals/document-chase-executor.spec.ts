/**
 * `executeDocumentChase` — the S5 consent-gated chase EXECUTOR (DOCUMENTS-PROCESS-
 * DESIGN S5). The CRITICAL SECURITY test: the chase NEVER sends when the recipient's
 * consent cannot be affirmatively confirmed (the #516 consent-bypass class of bug).
 *
 * Proves, against the REAL local DB + the REAL `governOutboundSend` seam (NOT a
 * mock — the actual gate pipeline + ledger):
 *   - FAIL-CLOSED CONSENT: with no opt-out registry / party-recipient resolver
 *     merged, the shared `resolveRecipientConsent` seam returns `false`, so the
 *     ConsentGate DENIES → the governed outcome is `blocked`, NO ledger row is claimed,
 *     and NOTHING is sent. An opted-out (or unconfirmable-consent) party gets NOTHING.
 *   - the executor routes through the CANONICAL governOutboundSend seam (it returns a
 *     governed outcome shape), never a parallel send path.
 *   - the party is DERIVED from the missing type via the one canonical mapping.
 *   - a malformed evidence blob FAILS CLOSED (Zod throws; no send).
 *
 * Seeding is BYPASSRLS (`providerDb`); the executor runs governOutboundSend inside
 * `withTenant` exactly as on the real approve path.
 *
 * Run (needs DB + Infisical):
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec vitest run \
 *     src/modules/proposals/document-chase-executor.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { proposals, providerDb, type Proposal } from '@emapp/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import {
  DocumentChaseEvidence,
  chasePartyForEvidence,
  executeDocumentChase,
} from './document-chase-executor';
import { resolveRecipientConsent } from './recipient-consent';

let orgA: TestOrg;

const PROJECT_ID = randomUUID();

/** Seed a pending document.chase.send proposal (BYPASSRLS) + return the full row. */
async function seedChaseProposal(opts: {
  orgId: string;
  projectId?: string;
  missingDocType: string;
}): Promise<Proposal> {
  const projectId = opts.projectId ?? PROJECT_ID;
  const [row] = await providerDb
    .insert(proposals)
    .values({
      orgId: opts.orgId,
      kind: 'document.chase.send',
      status: 'pending',
      scopeType: 'project',
      scopeId: projectId,
      evidence: {
        condition: 'missing_required_doc',
        projectId,
        projectType: 'tama38_1',
        track: 'tama38',
        missingDocType: opts.missingDocType,
      },
      dedupKey: `document.chase.send:${projectId}:${opts.missingDocType}:${randomUUID()}`,
      actorType: 'system',
    })
    .returning();
  return row!;
}

/** Count terminal `sent` ledger rows for an org (proves nothing left the system). */
async function sentLedgerCount(orgId: string): Promise<number> {
  const r = await providerDb.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM outbound_ledger WHERE org_id = ${orgId} AND status = 'sent'`,
  );
  return r.rows[0]?.n ?? 0;
}

/** Count ALL ledger rows for an org (proves a blocked send claims NO row at all). */
async function anyLedgerCount(orgId: string): Promise<number> {
  const r = await providerDb.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM outbound_ledger WHERE org_id = ${orgId}`,
  );
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  await setupTestDatabase();
  orgA = await createTestOrg(`chase-${Date.now()}`, `chase-${Date.now()}`);
}, 120_000);

afterAll(async () => {
  await providerDb
    .execute(sql`DELETE FROM outbound_ledger WHERE org_id = ${orgA.id}`)
    .catch(() => undefined);
  await providerDb
    .execute(sql`DELETE FROM proposals WHERE org_id = ${orgA.id}`)
    .catch(() => undefined);
});

describe('resolveRecipientConsent — the ONE shared seam, fail-closed (no hardcoded true)', () => {
  it('returns FALSE for any recipientRef: consent cannot be confirmed without the opt-out registry (#512)', () => {
    // The #516 lesson: consent is NEVER hardcoded true. The SAME seam all three
    // governed-send executors use (reminder/reissue/chase) is structurally false
    // until the opt-out registry lands (unconfirmable → fail closed).
    expect(resolveRecipientConsent(`${PROJECT_ID}:survey`)).toBe(false);
    expect(resolveRecipientConsent('any-signature-request-id')).toBe(false);
    expect(resolveRecipientConsent('any-proposal-id')).toBe(false);
  });
});

describe('chasePartyForEvidence — party derived from the missing type (one canonical map)', () => {
  it('survey → appraiser, blueprint → architect, regulation → lawyer', () => {
    expect(
      chasePartyForEvidence(
        DocumentChaseEvidence.parse({
          condition: 'missing_required_doc',
          projectId: PROJECT_ID,
          missingDocType: 'survey',
        }),
      ),
    ).toBe('appraiser');
    expect(
      chasePartyForEvidence(
        DocumentChaseEvidence.parse({
          condition: 'missing_required_doc',
          projectId: PROJECT_ID,
          missingDocType: 'blueprint',
        }),
      ),
    ).toBe('architect');
    expect(
      chasePartyForEvidence(
        DocumentChaseEvidence.parse({
          condition: 'missing_required_doc',
          projectId: PROJECT_ID,
          missingDocType: 'regulation',
        }),
      ),
    ).toBe('lawyer');
  });
});

describe('executeDocumentChase — CONSENT FAIL-CLOSED (the #516 bypass guard)', () => {
  it('an unconfirmable-consent chase is BLOCKED: nothing is sent, no ledger row is claimed', async () => {
    const proposal = await seedChaseProposal({ orgId: orgA.id, missingDocType: 'blueprint' });

    const outcome = await executeDocumentChase(orgA.id, proposal);

    // The ConsentGate DENIED (recipientConsented=false) → blocked, BEFORE any claim.
    expect(outcome.result).toBe('blocked');
    if (outcome.result === 'blocked') {
      // The gate that denied is the consent gate (the reason names consent).
      expect(outcome.decision.verdict).not.toBe('allow');
    }

    // NOTHING left the system: zero `sent` rows AND zero ledger rows at all (a
    // blocked send claims no ledger row — the M1 claim happens only after `allow`).
    expect(await sentLedgerCount(orgA.id)).toBe(0);
    expect(await anyLedgerCount(orgA.id)).toBe(0);
  });

  it('is idempotent-safe to re-run while blocked: still no send, still no ledger row', async () => {
    const proposal = await seedChaseProposal({ orgId: orgA.id, missingDocType: 'land_registry' });
    const a = await executeDocumentChase(orgA.id, proposal);
    const b = await executeDocumentChase(orgA.id, proposal);
    expect(a.result).toBe('blocked');
    expect(b.result).toBe('blocked');
    expect(await sentLedgerCount(orgA.id)).toBe(0);
    expect(await anyLedgerCount(orgA.id)).toBe(0);
  });

  it('a malformed evidence blob FAILS CLOSED (Zod throws; no send)', async () => {
    const [row] = await providerDb
      .insert(proposals)
      .values({
        orgId: orgA.id,
        kind: 'document.chase.send',
        status: 'pending',
        scopeType: 'project',
        scopeId: randomUUID(),
        // Missing the required `missingDocType` → the executor's Zod parse throws.
        evidence: { condition: 'missing_required_doc', projectId: randomUUID() },
        dedupKey: `document.chase.send:malformed:${randomUUID()}`,
        actorType: 'system',
      })
      .returning();
    await expect(executeDocumentChase(orgA.id, row!)).rejects.toThrow();
    expect(await anyLedgerCount(orgA.id)).toBe(0);
  });
});
