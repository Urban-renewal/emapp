import {
  AuditService,
  apartments,
  buildings,
  encryptField,
  encryptOwnerName,
  encryptOwnerPii,
  env as dbEnv,
  hashField,
  memberships,
  owners,
  ownerships,
  projectAssignments,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { Owner, OwnerPiiReveal } from '@emapp/shared-types';
import { normalizeIsraeliPhone } from '@emapp/validators';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import {
  requireAgentCapability,
  resolveOwnerPiiFidelity,
} from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

import type { CreateOwner, OwnerSearch, UpdateOwner } from './owner.dto';

export interface OwnerListPage {
  data: Owner[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

// national_id → "•••••••82" (7 bullets + last 2); phone → "•••••1234"
// (last 4). The decrypt + mask happen INSIDE the SQL select via the
// transaction-scoped app.encryption_key GUC, so: (a) ONE round-trip, no
// N+1 decrypt (D.24), and (b) the clear PII never leaves Postgres — only
// the masked suffix is selected. Keys are never interpolated into JS.
const NID_MASK = sql<string>`'•••••••' || right(pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text, 2)`;
const PHONE_MASK = sql<
  string | null
>`case when ${owners.phoneEncrypted} is null then null else '•••••' || right(pgp_sym_decrypt(${owners.phoneEncrypted}, current_setting('app.encryption_key'))::text, 4) end`;

// v8 §v8-S3 — name decrypted INSIDE SQL (same approach as the masks
// above) so we never pull the ciphertext over the wire to userland.
// app.encryption_key is set by withTenant via set_config.
const NAME_DECRYPTED = sql<string>`pgp_sym_decrypt(${owners.nameEncrypted}, current_setting('app.encryption_key'))::text`;

// D.54 (reveal-on-demand) — CLEARTEXT national_id / phone (full value),
// decrypted IN-SQL so the ciphertext never leaves Postgres. Used ONLY by the
// dedicated, audited `revealPii` endpoint (POST /owners/:id/reveal-pii) — NEVER
// in list/detail/search/export, which stay masked-for-everyone (the §v9-M-4
// tripwire holds for every list/detail surface).
const NID_CLEAR = sql<string>`pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text`;
const PHONE_CLEAR = sql<
  string | null
>`case when ${owners.phoneEncrypted} is null then null else pgp_sym_decrypt(${owners.phoneEncrypted}, current_setting('app.encryption_key'))::text end`;

// Masked owner projection — national_id/phone ALWAYS masked (D.47 tripwire),
// for every role on every list/detail surface. Cleartext is reachable only via
// `revealPii`. name decrypted in-SQL (§v8-S3); ciphertext never crosses the wire.
const ownerCols = {
  id: owners.id,
  organizationId: owners.orgId,
  name: NAME_DECRYPTED,
  email: owners.email,
  nationalIdMasked: NID_MASK,
  phoneMasked: PHONE_MASK,
  notes: owners.notes,
  createdAt: owners.createdAt,
  updatedAt: owners.updatedAt,
  archivedAt: owners.archivedAt,
} as const;

interface MaskedRow {
  id: string;
  organizationId: string;
  name: string;
  email: string | null;
  nationalIdMasked: string;
  phoneMasked: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}
const toOwner = (r: MaskedRow): Owner => ({ ...r });

/**
 * Owners domain service (Phase 3 Slice 4) — PII-bearing.
 *
 * Owners are ORG-scoped (owners.org_id → direct RLS inside withTenant);
 * cross-org id ⇒ 0 rows ⇒ 404 (no oracle). D.17: read (list/get/search)
 * = any org role; write (create/update/archive) = manager only.
 *
 * D.54 — agent owner READS are now scoped: an agent must hold `view_owners`
 * (else full deny) and sees ONLY owners with an active ownership in an
 * assigned-project apartment (list/search via a WHERE EXISTS; get via
 * assertOwnerInAssignedProject). Managers/viewers see all org owners.
 *
 * national_id/phone are pgcrypto-encrypted at rest and decrypted ONLY inside
 * SQL. EVERY list/detail/search surface returns the MASKED suffix only (D.47,
 * §v9-M-4 tripwire) — for every role. D.54 — cleartext is REVEAL-ON-DEMAND: the
 * dedicated, audited `revealPii` (POST /owners/:id/reveal-pii) returns the clear
 * national_id/phone of ONE owner, gated by `view_owner_pii` (manager always ·
 * agent per flag · viewer never) + owner-in-assigned-project scope, and writes a
 * per-access audit row (ISO A.12.4). Never logged elsewhere. Search matches by HMAC.
 */
@Injectable()
export class OwnersService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  /**
   * D.46 — owner EDIT project-scoping for agents. An agent may edit an owner
   * ONLY if that owner holds an ownership in an apartment whose building's
   * project is one the agent is actively assigned to
   * (owner→ownerships→apartments→buildings→project ∈ project_assignments).
   * No such path → 404 (no oracle — indistinguishable from a non-existent
   * owner; never leaks that the owner exists in another project/org).
   * Managers/viewers are unaffected (the caller already established
   * org-existence via RLS); this is the agent-only fine scope.
   */
  private async assertOwnerInAssignedProject(
    tx: TenantTx,
    user: AccessTokenPayload,
    ownerId: string,
  ): Promise<void> {
    if (user.role !== 'agent') return;
    const [hit] = await tx
      .select({ x: sql`1` })
      .from(owners)
      // ACTIVE ownership only — the D.25 set-replace SOFT-ends rows
      // (ended_at = now), it does not delete. Without this filter a
      // HISTORICAL link to an assigned project (e.g. an ownership later
      // transferred away) would grant edit indefinitely. `ended_at IS NULL`
      // is the universal "active ownership" predicate (matches every other
      // ownerships read + the partial indexes).
      .innerJoin(ownerships, and(eq(ownerships.ownerId, owners.id), isNull(ownerships.endedAt)))
      .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
      .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
      .innerJoin(
        projectAssignments,
        and(
          eq(projectAssignments.projectId, buildings.projectId),
          eq(projectAssignments.userId, user.sub),
          isNull(projectAssignments.unassignedAt),
        ),
      )
      .where(eq(owners.id, ownerId))
      .limit(1);
    if (!hit) throw NOT_FOUND;
  }

  /**
   * D.54 — view_owners READ gate. An agent must hold `view_owners` to see
   * owners AT ALL; otherwise full deny (403). Manager + viewer read freely
   * (viewer is always masked via the fidelity resolver). Agent-only.
   */
  private async assertAgentCanViewOwners(tx: TenantTx, user: AccessTokenPayload): Promise<void> {
    if (user.role !== 'agent') return;
    const [m] = await tx
      .select({ capabilities: memberships.capabilities })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.sub),
          eq(memberships.orgId, user.orgId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);
    if (!m || m.capabilities.view_owners !== true) throw FORBIDDEN;
  }

  /**
   * D.54 — agent owner-read scope (list/search). Restricts to owners holding an
   * ACTIVE ownership in an apartment whose project the agent is actively
   * assigned to (same join as assertOwnerInAssignedProject, as a WHERE EXISTS).
   * `undefined` for non-agents (no extra filter — managers/viewers see all).
   */
  private agentOwnerScope(user: AccessTokenPayload): SQL | undefined {
    if (user.role !== 'agent') return undefined;
    return sql`EXISTS (
      SELECT 1 FROM ownerships ow
      JOIN apartments a ON a.id = ow.apartment_id
      JOIN buildings b ON b.id = a.building_id
      JOIN project_assignments pa ON pa.project_id = b.project_id
        AND pa.user_id = ${user.sub} AND pa.unassigned_at IS NULL
      WHERE ow.owner_id = ${owners.id} AND ow.ended_at IS NULL
    )`;
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<OwnerListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        // D.54 — view_owners gate (agent off → 403) + agent project-scope. PII
        // is masked for everyone here; cleartext is reveal-on-demand only.
        await this.assertAgentCanViewOwners(tx, user);
        const scope = this.agentOwnerScope(user);
        const keyset: SQL | undefined = cur
          ? or(
              lt(owners.createdAt, new Date(cur.c)),
              and(eq(owners.createdAt, new Date(cur.c)), lt(owners.id, cur.i)),
            )
          : undefined;
        return tx
          .select(ownerCols)
          .from(owners)
          .where(and(isNull(owners.archivedAt), scope, keyset))
          .orderBy(desc(owners.createdAt), desc(owners.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toOwner),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async get(user: AccessTokenPayload, id: string): Promise<Owner> {
    const [row] = await withTenant(
      user.orgId,
      async (tx) => {
        // D.54 — view_owners gate, then agent project-scope (404 if the owner is
        // not in an assigned project — no oracle). Masked for everyone.
        await this.assertAgentCanViewOwners(tx, user);
        await this.assertOwnerInAssignedProject(tx, user, id);
        return tx.select(ownerCols).from(owners).where(eq(owners.id, id)).limit(1);
      },
      { userId: user.sub },
    );
    if (!row) throw NOT_FOUND;
    return toOwner(row);
  }

  /**
   * D.54 — reveal-on-demand cleartext PII for ONE owner. The list/detail/export
   * surfaces stay masked-for-everyone; this is the ONLY path to cleartext
   * national_id/phone over the wire, and it is gated + audited.
   *
   * Gate order (no-oracle): existence 404 (RLS org-scope) → agent project-scope
   * 404 (owner not in an assigned project is indistinguishable from absent, same
   * as edit) → `view_owner_pii` 403 (manager always · agent per flag · viewer
   * never, via `resolveOwnerPiiFidelity === 'unmasked'`). Scope is checked BEFORE
   * the capability so an out-of-scope owner never becomes a capability oracle.
   *
   * Writes a per-access audit row (`owner.pii_revealed`, ISO A.12.4 — WHO
   * revealed WHICH owner, WHEN) carrying only field NAMES, never the values.
   */
  async revealPii(user: AccessTokenPayload, id: string): Promise<OwnerPiiReveal> {
    return withTenant(
      user.orgId,
      async (tx) => {
        const [exists] = await tx
          .select({ id: owners.id })
          .from(owners)
          .where(eq(owners.id, id))
          .limit(1);
        if (!exists) throw NOT_FOUND;
        // Agent: owner must be in an actively-assigned project (404 if not —
        // before the capability check, so it stays a no-oracle 404).
        await this.assertOwnerInAssignedProject(tx, user, id);
        // view_owner_pii gate: manager always unmasked; agent iff the flag;
        // viewer never. Anything but `unmasked` → 403.
        const fidelity = await resolveOwnerPiiFidelity(tx, user);
        if (fidelity !== 'unmasked') throw FORBIDDEN;

        const [row] = await tx
          .select({ id: owners.id, nationalId: NID_CLEAR, phone: PHONE_CLEAR })
          .from(owners)
          .where(eq(owners.id, id))
          .limit(1);
        if (!row) throw NOT_FOUND;

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'owner.pii_revealed',
          targetTable: 'owners',
          targetId: id,
          // ISO A.12.4 — record WHO revealed WHICH owner + WHICH fields. NEVER
          // the cleartext values (CLAUDE.md / Doc07).
          afterState: { revealed: ['national_id', ...(row.phone != null ? ['phone'] : [])] },
          sessionId: user.sid,
        });

        return { id: row.id, nationalId: row.nationalId, phone: row.phone };
      },
      { userId: user.sub },
    );
  }

  // HMAC lookup (T3.O.1). The clear value arrives in the request BODY and
  // is HMAC'd here; it is never logged (also pino-redacted) nor persisted.
  async search(user: AccessTokenPayload, input: OwnerSearch): Promise<Owner[]> {
    const hashKey = dbEnv.PII_HASH_KEY as string;
    const conds: SQL[] = [];
    if (input.national_id)
      conds.push(eq(owners.nationalIdHash, hashField(input.national_id, hashKey)));
    if (input.phone) {
      const norm = normalizeIsraeliPhone(input.phone);
      if (norm) conds.push(eq(owners.phoneHash, hashField(norm, hashKey)));
    }
    if (conds.length === 0) return [];
    return withTenant(
      user.orgId,
      async (tx) => {
        // D.54 — view_owners gate + agent project-scope. An agent can still MATCH
        // by national_id/phone (HMAC), but only owners in their assigned projects;
        // results are masked for everyone (reveal-on-demand for cleartext).
        await this.assertAgentCanViewOwners(tx, user);
        const scope = this.agentOwnerScope(user);
        return tx
          .select(ownerCols)
          .from(owners)
          .where(and(isNull(owners.archivedAt), or(...conds), scope))
          .orderBy(desc(owners.createdAt), desc(owners.id))
          .limit(50)
          .then((rs) => rs.map(toOwner));
      },
      { userId: user.sub },
    );
  }

  async create(user: AccessTokenPayload, input: CreateOwner): Promise<Owner> {
    this.requireManager(user);
    // Normalize phone to E.164 (canonical form stored + HMAC'd). Validity
    // already enforced by the DTO refine.
    const phone = input.phone ? (normalizeIsraeliPhone(input.phone) ?? undefined) : undefined;
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          // v8 §v8-S3 — encryptOwnerPii now folds name encryption in
          // (3 fields encrypted in one helper call, 3 round-trips).
          const pii = await encryptOwnerPii(tx, {
            nationalId: input.national_id,
            phone,
            name: input.name,
          });
          const [ins] = await tx
            .insert(owners)
            .values({
              orgId: user.orgId,
              nameEncrypted: pii.nameEncrypted,
              nameHash: pii.nameHash,
              email: input.email ?? null,
              notes: input.notes ?? null,
              nationalIdEncrypted: pii.nationalIdEncrypted,
              nationalIdHash: pii.nationalIdHash,
              phoneEncrypted: pii.phoneEncrypted,
              phoneHash: pii.phoneHash,
            })
            .returning({ id: owners.id });
          if (!ins)
            throw new InternalServerErrorException({
              error: { code: 'insert_no_row', message: 'unexpected db state' },
            });
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'owner.create',
            targetTable: 'owners',
            targetId: ins.id,
            // v8.5 HIGH FIX (Audit SOLID #7 — concrete bug, single agent):
            //   Pre-v8.5 wrote `afterState: { name: input.name }` —
            //   storing the cleartext Hebrew name in `audit_log` even
            //   though §v8-S3 had just encrypted that column at rest.
            //   Defeated the entire point of v8-S3: a DB dump or backup
            //   contained PII names in audit_log unguarded by pgcrypto.
            //   Parity with update() (line ~300) which already uses the
            //   `{ changed: [...] }` field-name-only pattern. The
            //   created row itself carries the data — afterState only
            //   needs to enumerate WHAT changed for the audit trail,
            //   not WHAT THE VALUE WAS.
            afterState: {
              changed: [
                'name',
                'national_id',
                ...(phone ? (['phone'] as const) : []),
                ...(input.email ? (['email'] as const) : []),
                ...(input.notes ? (['notes'] as const) : []),
              ],
            },
            sessionId: user.sid,
          });
          // Masked-for-everyone (reveal-on-demand for cleartext).
          const [row] = await tx
            .select(ownerCols)
            .from(owners)
            .where(eq(owners.id, ins.id))
            .limit(1);
          if (!row)
            throw new InternalServerErrorException({
              error: { code: 'reload_no_row', message: 'unexpected db state' },
            });
          return toOwner(row);
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'owners_org_natid_unique_active')) {
        // Same-org duplicate national_id. Not an enumeration concern
        // (caller is already authenticated inside the org).
        throw new ConflictException({ error: { code: 'owner_exists' } });
      }
      throw e;
    }
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateOwner): Promise<Owner> {
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          // v8 §v8-S3: presence-only SELECT (name is encrypted; we
          // don't need to read it here — only to confirm visibility).
          const [before] = await tx
            .select({ id: owners.id })
            .from(owners)
            .where(eq(owners.id, id))
            .limit(1);
          if (!before) throw NOT_FOUND;
          // D.46 — agent: owner must be in an assigned project (404 if not,
          // before the capability check so it stays a no-oracle 404), then
          // the edit_project_data capability (403). Manager passes both.
          await this.assertOwnerInAssignedProject(tx, user, id);
          await requireAgentCapability(tx, user, 'edit_project_data');

          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (input.name !== undefined) {
            // v8 §v8-S3 — name updates go through encryptOwnerName
            // (single-field). No DB round-trip waste for unused
            // national_id / phone ciphertexts.
            const enc = await encryptOwnerName(tx, input.name);
            patch['nameEncrypted'] = enc.nameEncrypted;
            patch['nameHash'] = enc.nameHash;
          }
          if (input.email !== undefined) patch['email'] = input.email;
          if (input.notes !== undefined) patch['notes'] = input.notes;
          if (input.national_id !== undefined) {
            // v8 §v8-S3 — encryptOwnerPii now REQUIRES name. For a
            // national_id-only patch, use the field-level helpers
            // directly (same pattern as the phone branch below).
            patch['nationalIdEncrypted'] = await encryptField(
              tx,
              input.national_id,
              dbEnv.PII_ENCRYPTION_KEY as string,
            );
            patch['nationalIdHash'] = hashField(input.national_id, dbEnv.PII_HASH_KEY as string);
          }
          if (input.phone !== undefined) {
            if (input.phone === null) {
              patch['phoneEncrypted'] = null;
              patch['phoneHash'] = null;
            } else {
              // Phone-only change: encrypt/HMAC the phone DIRECTLY (no dummy
              // national_id round-trip — avoids wasted crypto and the
              // foot-gun of an unused fake-id ciphertext). Canonical E.164.
              const norm = normalizeIsraeliPhone(input.phone) ?? input.phone;
              patch['phoneEncrypted'] = await encryptField(
                tx,
                norm,
                dbEnv.PII_ENCRYPTION_KEY as string,
              );
              patch['phoneHash'] = hashField(norm, dbEnv.PII_HASH_KEY as string);
            }
          }
          await tx.update(owners).set(patch).where(eq(owners.id, id));
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'owner.update',
            targetTable: 'owners',
            targetId: id,
            // NO PII — record only WHICH fields changed.
            afterState: { changed: Object.keys(patch).filter((k) => k !== 'updatedAt') },
            sessionId: user.sid,
          });
          // Masked-for-everyone (reveal-on-demand for cleartext).
          const [row] = await tx.select(ownerCols).from(owners).where(eq(owners.id, id)).limit(1);
          if (!row) throw NOT_FOUND;
          return toOwner(row);
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'owners_org_natid_unique_active')) {
        throw new ConflictException({ error: { code: 'owner_exists' } });
      }
      throw e;
    }
  }

  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({ id: owners.id, archivedAt: owners.archivedAt })
          .from(owners)
          .where(eq(owners.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        await this.assertOwnerInAssignedProject(tx, user, id);
        await requireAgentCapability(tx, user, 'edit_project_data');
        if (before.archivedAt) return;
        await tx
          .update(owners)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(owners.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'owner.archive',
          targetTable: 'owners',
          targetId: id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }
}

// Walk the pg error / drizzle cause chain for a specific unique-constraint
// violation (SQLSTATE 23505). Mirrors auth.service's duplicate handling.
function isUniqueViolation(e: unknown, constraint: string): boolean {
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 6) {
    const pg = cur as { code?: string; constraint?: string; message?: string };
    if (pg.code === '23505' && (pg.constraint === constraint || pg.message?.includes(constraint))) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
    depth += 1;
  }
  return false;
}
