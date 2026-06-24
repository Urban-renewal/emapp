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
  projects,
  recipientOptOuts,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import {
  ProjectStatusEnum,
  ProjectTypeEnum,
  type Owner,
  type OwnerListItem,
  type OwnerPiiReveal,
  type OwnerProjectSummary,
} from '@emapp/shared-types';
import { normalizeIsraeliPhone } from '@emapp/validators';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';

import {
  requireAgentCapability,
  resolveOwnerPiiFidelity,
} from '../../common/authz/agent-capabilities';
import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

import type { CreateOwner, OwnerOptOut, OwnerSearch, UpdateOwner } from './owner.dto';

export interface OwnerListPage {
  data: OwnerListItem[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

// national_id → "•••••••82" (7 bullets + last 2); phone → "•••••1234"
// (last 4). The decrypt + mask happen INSIDE the SQL select via the
// transaction-scoped app.encryption_key GUC, so: (a) ONE round-trip, no
// N+1 decrypt (D.24), and (b) the clear PII never leaves Postgres — only
// the masked suffix is selected. Keys are never interpolated into JS.
// S3a — a SHELL owner has NULL national_id_encrypted; the mask is then NULL
// (not an empty/garbled string). pgp_sym_decrypt(NULL) is NULL, so the
// concat already yields NULL — the explicit CASE makes that intent obvious.
const NID_MASK = sql<
  string | null
>`case when ${owners.nationalIdEncrypted} is null then null else '•••••••' || right(pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text, 2) end`;
const PHONE_MASK = sql<
  string | null
>`case when ${owners.phoneEncrypted} is null then null else '•••••' || right(pgp_sym_decrypt(${owners.phoneEncrypted}, current_setting('app.encryption_key'))::text, 4) end`;

// v8 §v8-S3 — name decrypted INSIDE SQL (same approach as the masks
// above) so we never pull the ciphertext over the wire to userland.
// app.encryption_key is set by withTenant via set_config.
// S3a — NULL for a SHELL owner (no name yet). pgp_sym_decrypt(NULL) is NULL,
// so the projection carries a null name the FE renders as a placeholder.
const NAME_DECRYPTED = sql<
  string | null
>`pgp_sym_decrypt(${owners.nameEncrypted}, current_setting('app.encryption_key'))::text`;

// D.54 (reveal-on-demand) — CLEARTEXT national_id / phone (full value),
// decrypted IN-SQL so the ciphertext never leaves Postgres. Used ONLY by the
// dedicated, audited `revealPii` endpoint (POST /owners/:id/reveal-pii) — NEVER
// in list/detail/search/export, which stay masked-for-everyone (the §v9-M-4
// tripwire holds for every list/detail surface).
// S3a — NULL for a SHELL owner (no national_id yet).
const NID_CLEAR = sql<
  string | null
>`pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text`;
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
  // S3a — null for a SHELL owner (no name yet).
  name: string | null;
  email: string | null;
  // S3a — null for a SHELL owner (no national_id yet).
  nationalIdMasked: string | null;
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

  /**
   * List-only management aggregates per owner: how many apartments they
   * actively own + how many signature requests are still pending. Returned as
   * correlated scalar subqueries so the page stays ONE round-trip (no N+1) and
   * keyset pagination on owners.created_at/id is untouched. count(*)::int never
   * yields NULL (a no-match owner ⇒ 0), so the wire field is always a number.
   *
   * For an AGENT the counts are project-scoped exactly like agentOwnerScope: the
   * apartment count joins ownerships→apartments→buildings→project_assignments,
   * and the pending-signature count joins signature_requests→documents→
   * apartments→buildings→project_assignments. An unscoped count would leak the
   * SIZE of an owner's footprint in projects the agent isn't assigned to —
   * information the row itself withholds — so the scope is a security control,
   * not just a filter. Manager/viewer roles count org-wide (RLS-bound).
   */
  private listAggregateCols(user: AccessTokenPayload): {
    apartmentCount: SQL<number>;
    pendingSignatureCount: SQL<number>;
  } {
    // NB: the correlated reference to the outer row is the literal,
    // table-qualified `owners.id` — NOT a drizzle `${owners.id}` interpolation.
    // Drizzle renders the latter as a BARE "id" inside a raw subquery, which
    // then binds to the inner table's own id (ownerships.id / signature_
    // requests.id) and silently makes the predicate `ow.owner_id = ow.id` —
    // a false match that counts 0. `owners.id` is unambiguous here because no
    // subquery aliases a table `owners`.
    if (user.role === 'agent') {
      return {
        apartmentCount: sql<number>`(
          SELECT count(*)::int FROM ownerships ow
          JOIN apartments a ON a.id = ow.apartment_id
          JOIN buildings b ON b.id = a.building_id
          JOIN project_assignments pa ON pa.project_id = b.project_id
            AND pa.user_id = ${user.sub} AND pa.unassigned_at IS NULL
          WHERE ow.owner_id = owners.id AND ow.ended_at IS NULL
        )`,
        pendingSignatureCount: sql<number>`(
          SELECT count(*)::int FROM signature_requests sr
          JOIN documents d ON d.id = sr.document_id
          JOIN apartments a ON a.id = d.apartment_id
          JOIN buildings b ON b.id = a.building_id
          JOIN project_assignments pa ON pa.project_id = b.project_id
            AND pa.user_id = ${user.sub} AND pa.unassigned_at IS NULL
          WHERE sr.owner_id = owners.id AND sr.status = 'pending'
        )`,
      };
    }
    return {
      apartmentCount: sql<number>`(
        SELECT count(*)::int FROM ownerships ow
        WHERE ow.owner_id = owners.id AND ow.ended_at IS NULL
      )`,
      pendingSignatureCount: sql<number>`(
        SELECT count(*)::int FROM signature_requests sr
        WHERE sr.owner_id = owners.id AND sr.status = 'pending'
      )`,
    };
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string; archived?: boolean },
  ): Promise<OwnerListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    // Default view = ACTIVE owners; `archived: true` returns the archived ones
    // (so soft-archived records are reachable from the cockpit, not invisible).
    // Erased (crypto-shredded) owners are excluded from BOTH views.
    const archivedFilter = query.archived
      ? isNotNull(owners.archivedAt)
      : isNull(owners.archivedAt);
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        // D.54 — view_owners gate (agent off → 403) + agent project-scope. PII
        // is masked for everyone here; cleartext is reveal-on-demand only.
        await this.assertAgentCanViewOwners(tx, user);
        const scope = this.agentOwnerScope(user);
        const keyset: SQL | undefined = cur
          ? keysetCondition(owners.createdAt, owners.id, cur)
          : undefined;
        return tx
          .select({ ...ownerCols, ...this.listAggregateCols(user) })
          .from(owners)
          .where(and(archivedFilter, isNull(owners.erasedAt), scope, keyset))
          .orderBy(...keysetOrderBy(owners.createdAt, owners.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => ({
        ...toOwner(r),
        apartmentCount: r.apartmentCount,
        pendingSignatureCount: r.pendingSignatureCount,
      })),
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
        // P0.C1 — an erased owner (right-to-be-forgotten) is excluded from
        // detail too: their PII is crypto-shredded, so detail would only show a
        // tombstone. Treat as not-found (no oracle).
        return tx
          .select(ownerCols)
          .from(owners)
          .where(and(eq(owners.id, id), isNull(owners.erasedAt)))
          .limit(1);
      },
      { userId: user.sub },
    );
    if (!row) throw NOT_FOUND;
    return toOwner(row);
  }

  /**
   * S3d — the DISTINCT projects an owner is tied to via ACTIVE ownerships:
   * owner → ownerships (ended_at IS NULL) → apartments → buildings → projects.
   *
   * Returns a lean PROJECT summary list ({ id, name, type, status }) — NOT owner
   * PII. The endpoint answers "which projects", so national_id/phone/name never
   * appear here.
   *
   * Scoping (no project the caller can't see ever surfaces):
   *  - withTenant org-scope (RLS) — an owner in org A never surfaces org B's
   *    projects; `projects.org_id` is RLS-bound inside the tx.
   *  - view_owners gate FIRST (agent without it → 403; same outermost gate as
   *    list/get).
   *  - Existence + agent project-scope via assertOwnerInAssignedProject: a
   *    cross-org / out-of-scope owner collapses to 404 (no oracle), exactly like
   *    `get`. We pre-check raw existence (RLS-scoped) so a manager/viewer also
   *    gets a clean 404 for an absent owner.
   *  - AGENT additionally sees ONLY the owner's projects in their
   *    project_assignments (the WHERE EXISTS mirrors agentOwnerScope) — so even a
   *    multi-project owner never leaks a project the agent isn't assigned to.
   *
   * DISTINCT collapses an owner with two apartments in the same project to one
   * row.
   */
  async listProjects(
    user: AccessTokenPayload,
    ownerId: string,
  ): Promise<{ data: OwnerProjectSummary[] }> {
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        // view_owners gate FIRST (agent off → 403), then existence + agent
        // project-scope (404, no oracle) — same posture as get/revealPii.
        await this.assertAgentCanViewOwners(tx, user);
        const [exists] = await tx
          .select({ id: owners.id })
          .from(owners)
          .where(and(eq(owners.id, ownerId), isNull(owners.erasedAt)))
          .limit(1);
        if (!exists) throw NOT_FOUND;
        await this.assertOwnerInAssignedProject(tx, user, ownerId);

        // Agent: restrict the surfaced projects to the agent's actively-assigned
        // ones (an owner may sit in projects the agent can't see — those must
        // NOT appear). Non-agents (manager/viewer): all of the owner's in-org
        // projects. The owner→…→project path uses ACTIVE ownerships only.
        const agentScope: SQL | undefined =
          user.role === 'agent'
            ? sql`EXISTS (
                SELECT 1 FROM project_assignments pa
                WHERE pa.project_id = ${projects.id}
                  AND pa.user_id = ${user.sub}
                  AND pa.unassigned_at IS NULL
              )`
            : undefined;

        return tx
          .selectDistinct({
            id: projects.id,
            name: projects.name,
            type: projects.type,
            status: projects.status,
          })
          .from(ownerships)
          .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
          .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
          .innerJoin(projects, eq(projects.id, buildings.projectId))
          .where(and(eq(ownerships.ownerId, ownerId), isNull(ownerships.endedAt), agentScope));
      },
      { userId: user.sub },
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        // Narrow the DB enums through the shared-types SoT (a value outside the
        // locked set is a data-integrity bug, not a 200 with a bad enum).
        type: ProjectTypeEnum.parse(r.type),
        status: ProjectStatusEnum.parse(r.status),
      })),
    };
  }

  /**
   * D.54 — reveal-on-demand cleartext PII for ONE owner. The list/detail/export
   * surfaces stay masked-for-everyone; this is the ONLY path to cleartext
   * national_id/phone over the wire, and it is gated + audited.
   *
   * Gate order (no-oracle): `view_owners` 403 (an agent who cannot see owners AT
   * ALL cannot reveal one — the SAME outermost gate as list/get; this also makes
   * the contradictory `{view_owners:false, view_owner_pii:true}` grant inert) →
   * existence 404 (RLS org-scope) → agent project-scope 404 (owner not in an
   * assigned project is indistinguishable from absent, same as edit) →
   * `view_owner_pii` 403 (manager always · agent per flag · viewer never, via
   * `resolveOwnerPiiFidelity === 'unmasked'`). Scope is checked BEFORE the pii
   * capability so an out-of-scope owner never becomes a capability oracle.
   *
   * Writes a per-access audit row (`owner.pii_revealed`, ISO A.12.4 — WHO
   * revealed WHICH owner, WHEN) carrying only field NAMES, never the values.
   */
  async revealPii(user: AccessTokenPayload, id: string): Promise<OwnerPiiReveal> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // view_owners gate FIRST (outermost) — an agent without it sees no
        // owners anywhere, so it cannot reveal one. Manager/viewer pass.
        await this.assertAgentCanViewOwners(tx, user);
        const [exists] = await tx
          .select({ id: owners.id })
          .from(owners)
          // P0.C1 — an erased owner is UN-REVEALABLE: their cleartext PII is
          // crypto-shredded, so reveal collapses to 404 (no oracle — same as a
          // non-existent owner). The erasure tombstone is never surfaced.
          .where(and(eq(owners.id, id), isNull(owners.erasedAt)))
          .limit(1);
        if (!exists) throw NOT_FOUND;
        // Agent: owner must be in an actively-assigned project (404 if not —
        // before the pii capability check, so it stays a no-oracle 404).
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

  /**
   * HMAC lookup (T3.O.1). The clear value arrives in the request BODY and is
   * HMAC'd here; it is never logged (also pino-redacted) nor persisted.
   *
   * NS2 (MASTER-PLAN-V13 Wave B) — the `national_id` branch is a keyed-HMAC
   * equality lookup on the indexed `national_id_hash` column (NOT
   * decrypt-and-compare, NOT a ciphertext LIKE): the cleartext ID never leaves
   * the request boundary, and the only thing compared in SQL is the keyed hash.
   *
   * SCOPE = THE BOUNDARY (no widening): the national_id match runs INSIDE the
   * SAME scope-filtered query as every other owners read — RLS org-scope (cross-
   * org isolation) + the agent assigned-project `scope` EXISTS-subquery. So the
   * match is bounded by what the caller can ALREADY see: a manager/viewer matches
   * across the org's projects (their normal scope); an AGENT matches only owners
   * in their ASSIGNED projects. An agent CANNOT find an owner outside their
   * assigned scope by national_id — RLS + `agentOwnerScope` already exclude that
   * owner from the query, so there is no oracle beyond the caller's existing
   * access. This is why a plain agent (view_owners, no view_owner_pii) can still
   * find an ASSIGNED owner by national_id (D.54 DV-8) — it is safe.
   *
   * `view_owner_pii` is NOT consulted here: this slice adds NO cross-scope
   * WIDENING branch (no "match owners beyond the caller's normal scope"), and
   * with no widening, view_owner_pii has nothing extra to gate. The reveal path
   * (cleartext national_id) remains the separate, view_owner_pii-gated, audited
   * `revealPii` endpoint. The masked projection here is unchanged: finding an
   * owner by ID does NOT reveal the cleartext ID — `nationalIdMasked` stays
   * masked for everyone.
   *
   * AUDIT: every national_id lookup (any caller authorized to see owners) writes
   * an `owner.pii_lookup` row (ISO A.12.4 — WHO searched by national_id, in WHICH
   * org, WHEN) — a national_id search is audit-worthy PII-search activity. The
   * lookup ITSELF is the audited event (written whether or not a row matched).
   * NO `targetId` (a lookup spans 0..N owners; pinning it to one would itself be
   * a soft oracle) and the national_id value is NEVER in the payload (only the
   * field NAME + the result count).
   *
   * The phone branch is unchanged (governed by the existing owners.read +
   * view_owners gates + the same scope filter).
   */
  async search(user: AccessTokenPayload, input: OwnerSearch): Promise<Owner[]> {
    const hashKey = dbEnv.PII_HASH_KEY as string;
    return withTenant(
      user.orgId,
      async (tx) => {
        // D.54 — view_owners gate + agent project-scope. An agent can still MATCH
        // by phone / national_id (HMAC), but ONLY owners in their assigned
        // projects (the `scope` filter below); results are masked for everyone.
        await this.assertAgentCanViewOwners(tx, user);

        const conds: SQL[] = [];

        // NS2 — national_id HMAC match. Runs for ALL roles INSIDE the scope-
        // filtered query (RLS org-scope + agentOwnerScope below) — the caller's
        // EXISTING access IS the boundary, so an agent matches only owners in
        // their assigned projects (DV-8) and never one outside that scope. No
        // view_owner_pii gate: there is no cross-scope widening branch to gate.
        const nationalIdLookup = Boolean(input.national_id);
        if (input.national_id) {
          conds.push(eq(owners.nationalIdHash, hashField(input.national_id, hashKey)));
        }

        if (input.phone) {
          const norm = normalizeIsraeliPhone(input.phone);
          if (norm) conds.push(eq(owners.phoneHash, hashField(norm, hashKey)));
        }

        // No effective match condition (neither field present / parseable) →
        // empty result, no audit row (nothing was searched).
        if (conds.length === 0) return [];

        const scope = this.agentOwnerScope(user);
        const rows = await tx
          .select(ownerCols)
          .from(owners)
          .where(and(isNull(owners.archivedAt), isNull(owners.erasedAt), or(...conds), scope))
          .orderBy(desc(owners.createdAt), desc(owners.id))
          .limit(50);

        // NS2 audit — record the national_id lookup itself (ISO A.12.4). Written
        // whether or not it matched. NO targetId (spans 0..N owners — pinning one
        // would be a soft oracle). NEVER the national_id value — only the field
        // name searched + the (scope-bounded) result count.
        if (nationalIdLookup) {
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'owner.pii_lookup',
            targetTable: 'owners',
            afterState: { searched_by: 'national_id', result_count: rows.length },
            sessionId: user.sid,
          });
        }

        return rows.map(toOwner);
      },
      { userId: user.sub },
    );
  }

  /**
   * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — owner NAME search,
   * keyset-paginated. DISTINCT from `search` (the POST by-PII HMAC lookup):
   * this is a SUBSTRING match over the owner NAME, returning the SAME
   * masked-PII projection as `list` (national_id/phone ALWAYS masked — D.47
   * tripwire; cleartext is reveal-on-demand only).
   *
   * SECURITY: the owner name is PII stored ENCRYPTED at rest. We decrypt it
   * IN-SQL (pgp_sym_decrypt under the withTenant app.encryption_key GUC) and
   * ILIKE the plaintext — the ciphertext never crosses the wire, and the only
   * cleartext that leaves is the `name` field the masked projection already
   * returns. national_id/phone stay masked. The `q` value is bound as a
   * PARAMETER (drizzle parameterises ${...}) with LIKE metacharacters escaped,
   * so there is no injection surface and "50%" matches literal text.
   *
   * AUTHZ is identical to `list`/`search`: view_owners gate (agent off → 403),
   * agent project-scope (only owners in assigned-project apartments), org
   * isolation via RLS, erased owners excluded. Keyset order matches `list`
   * (createdAt desc, id desc) so the cursor is interchangeable.
   */
  async searchByName(
    user: AccessTokenPayload,
    query: { q: string; limit: number; cursor?: string },
  ): Promise<OwnerListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    // Escape LIKE metacharacters → literal substring (no user-driven wildcards).
    const escaped = query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        // Same outermost gate + agent scope as list/search; masked for everyone.
        await this.assertAgentCanViewOwners(tx, user);
        const scope = this.agentOwnerScope(user);
        const keyset: SQL | undefined = cur
          ? keysetCondition(owners.createdAt, owners.id, cur)
          : undefined;
        // Decrypt the name IN-SQL and ILIKE the plaintext. A SHELL owner with a
        // NULL name_encrypted decrypts to NULL → never matches (correct: a
        // nameless shell is not a name hit).
        const nameMatch = sql`pgp_sym_decrypt(${owners.nameEncrypted}, current_setting('app.encryption_key'))::text ILIKE ${pattern}`;
        return tx
          .select({ ...ownerCols, ...this.listAggregateCols(user) })
          .from(owners)
          .where(and(isNull(owners.archivedAt), isNull(owners.erasedAt), nameMatch, scope, keyset))
          .orderBy(...keysetOrderBy(owners.createdAt, owners.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => ({
        ...toOwner(r),
        apartmentCount: r.apartmentCount,
        pendingSignatureCount: r.pendingSignatureCount,
      })),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
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
                // S3a — name/national_id are optional for owner SHELLS; only
                // record the fields that were actually supplied.
                ...(input.name ? (['name'] as const) : []),
                ...(input.national_id ? (['national_id'] as const) : []),
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

  /**
   * M2 — mark an owner OPTED OUT of autonomous outbound (the recipient_opt_outs
   * registry the ConsentGate reads). The MANAGER/ADMIN ingestion path (the
   * cleanest, most secure ONE for MVP — no public token, no PII-in-URL, reuses
   * the proven owner-scope + agent-capability machinery). An unsubscribe-link
   * endpoint (an unguessable, recipient-scoped token a reminder can carry) and a
   * provider STOP webhook are the noted follow-ups; both write the SAME registry.
   *
   * Scope mirrors `update`: an agent must have the owner in an assigned project
   * (no-oracle 404) + the `edit_project_data` capability; a manager passes both.
   * IDEMPOTENT: a re-opt-out for the same (owner, channel) UPSERTs (refreshes
   * `opted_out_at`/`source`) — never a duplicate. Durable (no DELETE). Audited
   * (NO PII — only the owner id + channel). RLS scopes the write to the org.
   */
  async optOut(user: AccessTokenPayload, id: string, input: OwnerOptOut): Promise<void> {
    await withTenant(
      user.orgId,
      async (tx) => {
        // Visibility presence-check (RLS already org-scopes; this gives the
        // no-oracle 404 for a foreign/absent id BEFORE the capability gate).
        const [before] = await tx
          .select({ id: owners.id })
          .from(owners)
          .where(eq(owners.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        await this.assertOwnerInAssignedProject(tx, user, id);
        await requireAgentCapability(tx, user, 'edit_project_data');

        // Durable, idempotent UPSERT on (org, owner, channel). A repeated opt-out
        // refreshes the timestamp/source; it NEVER duplicates. The row's mere
        // existence IS the opt-out the ConsentGate denies on.
        await tx
          .insert(recipientOptOuts)
          .values({
            orgId: user.orgId,
            ownerId: id,
            channel: input.channel,
            source: input.source,
            optedOutAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [recipientOptOuts.orgId, recipientOptOuts.ownerId, recipientOptOuts.channel],
            set: { optedOutAt: new Date(), source: input.source },
          });

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'owner.outbound_opt_out',
          targetTable: 'recipient_opt_outs',
          targetId: id,
          // NO PII — only the channel + provenance.
          afterState: { channel: input.channel, source: input.source },
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
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
