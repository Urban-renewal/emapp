import {
  AuditService,
  encryptField,
  env as dbEnv,
  isOrgSuspended,
  owners,
  ownerStates,
  withTenant,
} from '@emapp/db';
import {
  BLOCKING_OWNER_STATE_KINDS,
  type CreateOwnerState,
  type OwnerStateKind,
  type OwnerStateView,
} from '@emapp/shared-types';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/**
 * Mask a guardian name to a single leading grapheme + ellipsis ("דנה" → "ד•••").
 * Computed IN-SQL so the cleartext guardian name never leaves Postgres — only the
 * masked first character crosses into userland (mirrors the owner NID/phone masks).
 * NULL guardian (no name on file) ⇒ NULL. Hebrew-safe: `left(...,1)` is codepoint-
 * based in pg, which is fine for the single leading letter.
 */
const GUARDIAN_NAME_MASK = sql<
  string | null
>`case when ${ownerStates.guardianNameEncrypted} is null then null
       else left(pgp_sym_decrypt(${ownerStates.guardianNameEncrypted}, current_setting('app.encryption_key'))::text, 1) || '•••' end`;

/** Whether a guardian CONTACT (phone) is on file — a boolean, never the value. */
const HAS_GUARDIAN_CONTACT = sql<boolean>`(${ownerStates.guardianPhoneEncrypted} is not null)`;

/** The masked owner-state projection. NO cleartext guardian PII is selected —
 *  only the masked name + a has-contact boolean. */
const ownerStateCols = {
  id: ownerStates.id,
  ownerId: ownerStates.ownerId,
  kind: ownerStates.kind,
  subKind: ownerStates.subKind,
  status: ownerStates.status,
  guardianNameMasked: GUARDIAN_NAME_MASK,
  hasGuardianContact: HAS_GUARDIAN_CONTACT,
  createdAt: ownerStates.createdAt,
  resolvedAt: ownerStates.resolvedAt,
} as const;

interface OwnerStateRow {
  id: string;
  ownerId: string;
  kind: OwnerStateKind;
  subKind: string | null;
  status: 'active' | 'resolved';
  guardianNameMasked: string | null;
  hasGuardianContact: boolean;
  createdAt: Date;
  resolvedAt: Date | null;
}

const BLOCKING_SET = new Set<OwnerStateKind>(BLOCKING_OWNER_STATE_KINDS);

const toView = (r: OwnerStateRow): OwnerStateView => ({
  id: r.id,
  ownerId: r.ownerId,
  kind: r.kind,
  subKind: r.subKind,
  status: r.status,
  guardianNameMasked: r.guardianNameMasked,
  hasGuardianContact: r.hasGuardianContact,
  isBlocking: BLOCKING_SET.has(r.kind),
  createdAt: r.createdAt.toISOString(),
  resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
});

/**
 * Slice 2.5 — owner legal/life-state service (PII-bearing: guardian identity).
 *
 * Owner-states are ORG-scoped (owner_states.org_id → direct RLS inside withTenant);
 * a cross-org owner id ⇒ 0 owner rows ⇒ 404 (no oracle). Manager-gated writes
 * (create/resolve); reads are any-org-role (the controller's coarse `owners.read`
 * permission gates the tier; RLS owns the org boundary).
 *
 * GUARDIAN PII discipline (the load-bearing rule): guardian name/phone/national_id
 * are pgcrypto-encrypted at rest (encryptField, key PII_ENCRYPTION_KEY) and NEVER
 * returned cleartext — the view returns a MASKED guardian label only (decrypt +
 * mask happen INSIDE SQL; ciphertext never crosses the wire). Cleartext is NEVER
 * logged and NEVER placed in the audit afterState (which records WHICH guardian
 * fields were supplied, never their values — mirrors owners.create).
 */
@Injectable()
export class OwnerStatesService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  /** Assert the owner exists in the caller's org (RLS-scoped). 404 (no oracle)
   *  when missing/cross-org/erased — never leaks existence. */
  private async assertOwnerExists(
    tx: Parameters<Parameters<typeof withTenant>[1]>[0],
    ownerId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: owners.id })
      .from(owners)
      .where(and(eq(owners.id, ownerId), isNull(owners.erasedAt)))
      .limit(1);
    if (!row) throw NOT_FOUND;
  }

  /**
   * List the ACTIVE, non-archived owner-states for one owner (masked guardian).
   * Any org role (read). Newest first.
   */
  async listForOwner(user: AccessTokenPayload, ownerId: string): Promise<OwnerStateView[]> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // Fail-closed parity with the write paths: a suspended org surfaces no
        // owner-state data (no-oracle 404, never a partial/leaky read).
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        await this.assertOwnerExists(tx, ownerId);
        const rows = await tx
          .select(ownerStateCols)
          .from(ownerStates)
          .where(
            and(
              eq(ownerStates.ownerId, ownerId),
              eq(ownerStates.status, 'active'),
              isNull(ownerStates.archivedAt),
            ),
          )
          .orderBy(desc(ownerStates.createdAt), desc(ownerStates.id));
        return rows.map(toView);
      },
      { userId: user.sub },
    );
  }

  /**
   * Create an owner-state (manager only). Guardian PII (when supplied) is encrypted
   * IN-SQL before storage; the returned view is masked. The audit afterState records
   * WHICH guardian fields were supplied (field names only) — never their values.
   */
  async create(
    user: AccessTokenPayload,
    ownerId: string,
    input: CreateOwnerState,
  ): Promise<OwnerStateView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        await this.assertOwnerExists(tx, ownerId);

        const encKey = dbEnv.PII_ENCRYPTION_KEY as string;
        const guardianNameEncrypted = input.guardianName
          ? await encryptField(tx, input.guardianName, encKey)
          : null;
        const guardianPhoneEncrypted = input.guardianPhone
          ? await encryptField(tx, input.guardianPhone, encKey)
          : null;
        const guardianNationalIdEncrypted = input.guardianNationalId
          ? await encryptField(tx, input.guardianNationalId, encKey)
          : null;

        const [ins] = await tx
          .insert(ownerStates)
          .values({
            orgId: user.orgId,
            ownerId,
            kind: input.kind,
            subKind: input.subKind ?? null,
            guardianNameEncrypted,
            guardianPhoneEncrypted,
            guardianNationalIdEncrypted,
            status: 'active',
            createdBy: user.sub,
          })
          .returning({ id: ownerStates.id });
        if (!ins)
          throw new InternalServerErrorException({
            error: { code: 'insert_no_row', message: 'unexpected db state' },
          });

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'owner_state.create',
          targetTable: 'owner_states',
          targetId: ins.id,
          // PII-FREE afterState: the kind + WHICH guardian fields were supplied
          // (field names only) — NEVER the guardian name/phone/national_id values
          // (which were just encrypted at rest). `subKind` is bounded non-PII.
          afterState: {
            kind: input.kind,
            ...(input.subKind ? { subKind: input.subKind } : {}),
            guardianFields: [
              ...(input.guardianName ? (['name'] as const) : []),
              ...(input.guardianPhone ? (['phone'] as const) : []),
              ...(input.guardianNationalId ? (['national_id'] as const) : []),
            ],
          },
          sessionId: user.sid,
        });

        const [row] = await tx
          .select(ownerStateCols)
          .from(ownerStates)
          .where(eq(ownerStates.id, ins.id))
          .limit(1);
        if (!row)
          throw new InternalServerErrorException({
            error: { code: 'reload_no_row', message: 'unexpected db state' },
          });
        return toView(row);
      },
      { userId: user.sub },
    );
  }

  /**
   * Resolve an owner-state (manager only) — a status transition, NOT a delete.
   * Idempotent: resolving an already-resolved state is a no-op (returns the row).
   * 404 (no oracle) when the state is missing/cross-org. PII-free audit.
   */
  async resolve(user: AccessTokenPayload, stateId: string): Promise<OwnerStateView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;

        const [before] = await tx
          .select({ id: ownerStates.id, status: ownerStates.status })
          .from(ownerStates)
          .where(and(eq(ownerStates.id, stateId), isNull(ownerStates.archivedAt)))
          .limit(1);
        if (!before) throw NOT_FOUND;

        if (before.status === 'active') {
          await tx
            .update(ownerStates)
            .set({
              status: 'resolved',
              resolvedAt: new Date(),
              resolvedBy: user.sub,
              updatedAt: new Date(),
            })
            .where(eq(ownerStates.id, stateId));
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'owner_state.resolve',
            targetTable: 'owner_states',
            targetId: stateId,
            afterState: { status: 'resolved' },
            sessionId: user.sid,
          });
        }

        const [row] = await tx
          .select(ownerStateCols)
          .from(ownerStates)
          .where(eq(ownerStates.id, stateId))
          .limit(1);
        if (!row) throw NOT_FOUND;
        return toView(row);
      },
      { userId: user.sub },
    );
  }
}
