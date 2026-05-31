import {
  AuditService,
  apartments,
  buildings,
  encryptField,
  encryptOwnerName,
  encryptOwnerPii,
  env as dbEnv,
  hashField,
  owners,
  ownerships,
  projectAssignments,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { Owner } from '@emapp/shared-types';
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

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
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
 * Agent project-scoping is intentionally NOT applied to bare Owner records
 * here: an owner's project linkage is via ownerships→apartment→…(Slice 5),
 * and a name+masked-id row is not project-scoped data. Apartment-scoped
 * owner views arrive with Slice 5. (Recorded — PROGRESS doc-debt.)
 *
 * national_id/phone are pgcrypto-encrypted at rest and decrypted ONLY
 * inside SQL to a MASKED suffix — never returned, logged, or put in
 * errors/audit (CLAUDE.md / Doc07). Search matches by HMAC, body-only.
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
      .innerJoin(ownerships, eq(ownerships.ownerId, owners.id))
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
        const keyset: SQL | undefined = cur
          ? or(
              lt(owners.createdAt, new Date(cur.c)),
              and(eq(owners.createdAt, new Date(cur.c)), lt(owners.id, cur.i)),
            )
          : undefined;
        return tx
          .select(ownerCols)
          .from(owners)
          .where(and(isNull(owners.archivedAt), keyset))
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
      async (tx) => tx.select(ownerCols).from(owners).where(eq(owners.id, id)).limit(1),
      { userId: user.sub },
    );
    if (!row) throw NOT_FOUND;
    return toOwner(row);
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
      async (tx) =>
        tx
          .select(ownerCols)
          .from(owners)
          .where(and(isNull(owners.archivedAt), or(...conds)))
          .orderBy(desc(owners.createdAt), desc(owners.id))
          .limit(50)
          .then((rs) => rs.map(toOwner)),
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
