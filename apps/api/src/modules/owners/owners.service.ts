import {
  AuditService,
  encryptField,
  encryptOwnerPii,
  env as dbEnv,
  hashField,
  owners,
  withTenant,
} from '@emapp/db';
import type { Owner } from '@emapp/shared-types';
import { normalizeIsraeliPhone } from '@emapp/validators';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

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

const ownerCols = {
  id: owners.id,
  organizationId: owners.orgId,
  name: owners.name,
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
          const pii = await encryptOwnerPii(tx, { nationalId: input.national_id, phone });
          const [ins] = await tx
            .insert(owners)
            .values({
              orgId: user.orgId,
              name: input.name,
              email: input.email ?? null,
              notes: input.notes ?? null,
              nationalIdEncrypted: pii.nationalIdEncrypted,
              nationalIdHash: pii.nationalIdHash,
              phoneEncrypted: pii.phoneEncrypted,
              phoneHash: pii.phoneHash,
            })
            .returning({ id: owners.id });
          if (!ins) throw new Error('owner insert returned no row');
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'owner.create',
            targetTable: 'owners',
            targetId: ins.id,
            // NO PII in audit — name only.
            afterState: { name: input.name },
            sessionId: user.sid,
          });
          const [row] = await tx
            .select(ownerCols)
            .from(owners)
            .where(eq(owners.id, ins.id))
            .limit(1);
          if (!row) throw new Error('owner reload returned no row');
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
    this.requireManager(user);
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          const [before] = await tx
            .select({ id: owners.id, name: owners.name })
            .from(owners)
            .where(eq(owners.id, id))
            .limit(1);
          if (!before) throw NOT_FOUND;

          const patch: Record<string, unknown> = { updatedAt: new Date() };
          if (input.name !== undefined) patch['name'] = input.name;
          if (input.email !== undefined) patch['email'] = input.email;
          if (input.notes !== undefined) patch['notes'] = input.notes;
          if (input.national_id !== undefined) {
            const enc = await encryptOwnerPii(tx, { nationalId: input.national_id });
            patch['nationalIdEncrypted'] = enc.nationalIdEncrypted;
            patch['nationalIdHash'] = enc.nationalIdHash;
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
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({ id: owners.id, archivedAt: owners.archivedAt })
          .from(owners)
          .where(eq(owners.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
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
