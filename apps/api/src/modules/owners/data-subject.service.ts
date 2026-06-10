import {
  AuditService,
  apartments,
  buildings,
  buildErasureTombstone,
  documents,
  erasureLog,
  owners,
  ownerships,
  projects,
  SIGNATURE_BLOB_TOMBSTONE,
  signatures,
  users,
  withTenant,
} from '@emapp/db';
import type { OwnerDataExport, OwnerErasureResult } from '@emapp/shared-types';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

// CLEARTEXT decrypt, IN-SQL (ciphertext never crosses the wire). app.encryption_key
// is set by withTenant. Used ONLY by the audited data-export (a deliberate reveal).
// S3a — nationalId/name are nullable (SHELL owners): guard the decrypt so a NULL
// ciphertext yields NULL (not an error), and the type reflects it.
const NID_CLEAR = sql<
  string | null
>`case when ${owners.nationalIdEncrypted} is null then null else pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text end`;
const PHONE_CLEAR = sql<
  string | null
>`case when ${owners.phoneEncrypted} is null then null else pgp_sym_decrypt(${owners.phoneEncrypted}, current_setting('app.encryption_key'))::text end`;
const NAME_CLEAR = sql<
  string | null
>`case when ${owners.nameEncrypted} is null then null else pgp_sym_decrypt(${owners.nameEncrypted}, current_setting('app.encryption_key'))::text end`;

/**
 * P0.C1 — Data-subject rights service (Israeli Privacy Protection Law).
 *
 * SINGLE RESPONSIBILITY: the two privacy-law operations on an owner —
 *   1. ACCESS  (right to access)  → `dataExport`  — assemble EVERYTHING EMAPP
 *      holds about an owner (decrypted PII + ownerships + signature events +
 *      the projects/apartments they're tied to), audited as a PII reveal.
 *   2. ERASURE (right-to-be-forgotten) → `erase` — crypto-shred the PII
 *      in place while RETAINING the non-PII signature/ownership records (legal
 *      retention for the urban-renewal project survives, identity redacted).
 *
 * Kept SEPARATE from `OwnersService` (which owns CRUD + masked reads) so the
 * compliance surface has its own audited, manager-gated boundary. Both methods
 * mirror the `view_owner_pii` reveal posture: MANAGER-tier only, full audit,
 * every read/write through `withTenant`. PII is never logged / never in errors /
 * never in the erasure_log (only field NAMES are recorded).
 *
 * Authz: the controller's coarse gate is `owners.reveal_pii` (the dedicated
 * cleartext-access permission). The FINE check here re-asserts MANAGER-tier
 * (agents/viewers denied even if they reach the coarse gate) — defense in
 * depth. Data-subject access + erasure are deliberately manager-only (the
 * prompt MANDATE: manager-gated); an agent's per-flag `view_owner_pii` reveal
 * capability does NOT extend to these org-wide compliance operations.
 */
@Injectable()
export class DataSubjectService {
  /**
   * Re-assert the fine PII gate: MANAGER-tier only. Agents/viewers are denied
   * even if they reach the coarse `owners.reveal_pii` gate — data-subject
   * access/erasure is a manager-tier act (prompt MANDATE: manager-gated).
   */
  private assertManagerPii(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  /**
   * RIGHT TO ACCESS — the "data subject access response". Returns EVERYTHING
   * EMAPP holds about ONE owner: decrypted PII + their ownerships (with project
   * / apartment context) + their signature events (non-PII forensic metadata +
   * document hash). Audited as a PII reveal (`owner.data_exported`) recording
   * WHO exported WHICH owner — never the values.
   *
   * An ERASED owner is treated as not-found (no oracle) — there is nothing left
   * to export (the PII is crypto-shredded).
   */
  async dataExport(user: AccessTokenPayload, id: string): Promise<OwnerDataExport> {
    return withTenant(
      user.orgId,
      async (tx) => {
        this.assertManagerPii(user);

        // 1) The owner + decrypted PII. RLS scopes to org; erased → 404.
        const [ownerRow] = await tx
          .select({
            id: owners.id,
            organizationId: owners.orgId,
            name: NAME_CLEAR,
            nationalId: NID_CLEAR,
            phone: PHONE_CLEAR,
            email: owners.email,
            notes: owners.notes,
            createdAt: owners.createdAt,
            updatedAt: owners.updatedAt,
            archivedAt: owners.archivedAt,
            erasedAt: owners.erasedAt,
          })
          .from(owners)
          .where(and(eq(owners.id, id), isNull(owners.erasedAt)))
          .limit(1);
        if (!ownerRow) throw NOT_FOUND;

        // 2) Ownerships + project/apartment context (ALL — active + historical;
        //    a subject-access response is the complete picture, not just active).
        const ownershipRows = await tx
          .select({
            ownershipId: ownerships.id,
            apartmentId: apartments.id,
            apartmentNumber: apartments.number,
            buildingId: buildings.id,
            buildingAddress: buildings.address,
            projectId: projects.id,
            projectName: projects.name,
            ownershipPct: ownerships.ownershipPct,
            relationship: ownerships.relationship,
            role: ownerships.role,
            startedAt: ownerships.startedAt,
            endedAt: ownerships.endedAt,
          })
          .from(ownerships)
          .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
          .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
          .innerJoin(projects, eq(projects.id, buildings.projectId))
          .where(eq(ownerships.ownerId, id));

        // 3) Signature EVENTS (non-PII metadata + document hash — legal proof).
        //    The SVG blob is intentionally NOT included (see shared-types note).
        const signatureRows = await tx
          .select({
            signatureId: signatures.id,
            documentId: signatures.documentId,
            documentName: documents.name,
            documentHash: signatures.documentHash,
            authMethod: signatures.authMethod,
            signedAt: signatures.signedAt,
          })
          .from(signatures)
          .leftJoin(documents, eq(documents.id, signatures.documentId))
          .where(eq(signatures.ownerId, id));

        // 4) Audit the reveal — WHO exported WHICH owner + a row-count summary.
        //    NEVER the cleartext values (CLAUDE.md / Doc07).
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'owner.data_exported',
          targetTable: 'owners',
          targetId: id,
          afterState: {
            revealed: ['name', 'national_id', ...(ownerRow.phone != null ? ['phone'] : [])],
            ownershipCount: ownershipRows.length,
            signatureCount: signatureRows.length,
          },
          sessionId: user.sid,
        });

        return {
          exportedAt: new Date(),
          owner: {
            id: ownerRow.id,
            organizationId: ownerRow.organizationId,
            name: ownerRow.name,
            nationalId: ownerRow.nationalId,
            phone: ownerRow.phone,
            email: ownerRow.email,
            notes: ownerRow.notes,
            createdAt: ownerRow.createdAt,
            updatedAt: ownerRow.updatedAt,
            archivedAt: ownerRow.archivedAt,
            erasedAt: ownerRow.erasedAt,
          },
          ownerships: ownershipRows.map((r) => ({
            ownershipId: r.ownershipId,
            apartmentId: r.apartmentId,
            apartmentNumber: r.apartmentNumber,
            buildingId: r.buildingId,
            buildingAddress: r.buildingAddress,
            projectId: r.projectId,
            projectName: r.projectName,
            ownershipPct: Number(r.ownershipPct),
            relationship: r.relationship,
            role: r.role,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
          })),
          signatures: signatureRows.map((r) => ({
            signatureId: r.signatureId,
            documentId: r.documentId,
            documentName: r.documentName,
            documentHash: r.documentHash,
            authMethod: r.authMethod,
            signedAt: r.signedAt,
          })),
        };
      },
      { userId: user.sub },
    );
  }

  /**
   * RIGHT-TO-BE-FORGOTTEN — crypto-shred the owner's PII in place.
   *
   * Strategy (see docs/DECISION-erasure-vs-legal-retention.md):
   *   - OVERWRITE the encrypted PII columns (name/national_id/phone) with an
   *     irreversible tombstone ciphertext (encrypt-of-"[erased]") — the
   *     original plaintext is GONE.
   *   - NULL the HMAC lookup hashes (name_hash / national_id_hash / phone_hash)
   *     so the owner can no longer be FOUND by HMAC of the original value.
   *   - CLEAR the non-encrypted PII-adjacent fields (email, notes — notes can
   *     carry free-text PII).
   *   - MARK erased_at / erased_by + ALSO archived_at (so the existing
   *     archived-aware partials/unique-index exclude the row).
   *   - REDACT the biometric signature blob (erasure-completeness HIGH #1):
   *     overwrite `signature_blob` (the subject's handwritten-signature SVG, a
   *     biometric PII artifact) with a fixed non-PII tombstone, and NULL the
   *     forensic `signer_ip` / `signer_user_agent`. The signature ROW, its
   *     `document_hash`, `signed_at`, and the owner link are RETAINED — legal
   *     proof a signing event occurred survives; the visual mark does not.
   *   - RETAIN signatures + ownerships in place (NO cascade delete) — legal
   *     validity survives with the identity redacted.
   *   - WRITE an append-only `erasure_log` compliance row (field NAMES only,
   *     never values) + an audit row.
   *
   * IDEMPOTENT: a re-erase of an already-erased owner is a no-op (returns
   * `alreadyErased: true`, writes no second ledger row). IRREVERSIBLE.
   */
  async erase(
    user: AccessTokenPayload,
    id: string,
    input: { reason?: string },
  ): Promise<OwnerErasureResult> {
    return withTenant(
      user.orgId,
      async (tx) => {
        this.assertManagerPii(user);

        // Existence + current erasure state (org-scoped via RLS).
        const [existing] = await tx
          .select({ id: owners.id, erasedAt: owners.erasedAt })
          .from(owners)
          .where(eq(owners.id, id))
          .limit(1);
        if (!existing) throw NOT_FOUND;

        // IDEMPOTENT — already erased → no-op (no second crypto-shred, no second
        // ledger row). Return the existing tombstone timestamp.
        if (existing.erasedAt) {
          return {
            ownerId: id,
            erasedAt: existing.erasedAt,
            alreadyErased: true,
            clearedFields: [],
            signaturesRetained: 0,
            ownershipsRetained: 0,
          };
        }

        // REDACT the biometric signature blobs (erasure-completeness HIGH #1)
        // and count the RETAINED rows in one statement. For every signature row
        // tied to this owner we overwrite `signature_blob` (the handwritten-
        // signature SVG — biometric PII) with a fixed non-PII tombstone and NULL
        // the forensic `signer_ip` / `signer_user_agent`. We RETAIN the row, the
        // `document_hash`, `signed_at`, and the owner link (legal proof of the
        // signing event). `signatureBlob` is NOT NULL → the tombstone buffer
        // satisfies the constraint; `signerIp` / `signerUserAgent` are nullable.
        // RETURNING yields the redacted set, whose length IS the retained count.
        const redactedSigs = await tx
          .update(signatures)
          .set({
            signatureBlob: SIGNATURE_BLOB_TOMBSTONE,
            signerIp: null,
            signerUserAgent: null,
          })
          .where(eq(signatures.ownerId, id))
          .returning({ id: signatures.id });
        const sigCount = redactedSigs.length;

        const ownRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(ownerships)
          .where(eq(ownerships.ownerId, id));
        const ownCount = ownRows[0]?.count ?? 0;

        // Actor email — durable forensic copy for the ledger (AccessTokenPayload
        // carries no email; look it up). Best-effort: null if the user row is gone.
        const [actor] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, user.sub))
          .limit(1);

        // Crypto-shred: build the irreversible tombstone ciphertexts.
        const tombstone = await buildErasureTombstone(
          tx as unknown as Parameters<typeof buildErasureTombstone>[0],
        );

        const now = new Date();
        const clearedFields = [
          'name',
          'national_id',
          'phone',
          'name_hash',
          'national_id_hash',
          'phone_hash',
          'email',
          'notes',
          // erasure-completeness HIGH #1 — biometric signature artifact +
          // forensic metadata redacted on the retained signature rows. Field
          // NAMES only (the `signaturesRetained` count carries the cardinality);
          // never any PII value.
          'signature_blob',
          'signer_ip',
          'signer_user_agent',
        ];

        await tx
          .update(owners)
          .set({
            // Encrypted PII → irreversible tombstone (original plaintext gone).
            nameEncrypted: tombstone.nameEncrypted,
            nationalIdEncrypted: tombstone.nationalIdEncrypted,
            phoneEncrypted: tombstone.phoneEncrypted,
            // HMAC lookup hashes → NULL (can no longer be found by original value).
            nameHash: null,
            nationalIdHash: null,
            phoneHash: null,
            // Non-encrypted PII-adjacent fields → cleared.
            email: null,
            notes: null,
            // Tombstone markers + archive so existing partials exclude the row.
            erasedAt: now,
            erasedBy: user.sub,
            archivedAt: now,
            updatedAt: now,
          })
          .where(eq(owners.id, id));

        // Compliance ledger row — FIELD NAMES only, never values.
        await tx.insert(erasureLog).values({
          orgId: user.orgId,
          ownerId: id,
          actorId: user.sub,
          actorEmail: actor?.email ?? null,
          clearedFields,
          signaturesRetained: sigCount,
          ownershipsRetained: ownCount,
          reason: input.reason ?? null,
        });

        // Audit row (ISO A.12.4) — WHO erased WHICH owner; no PII values.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'owner.erased',
          targetTable: 'owners',
          targetId: id,
          afterState: {
            cleared: clearedFields,
            signaturesRetained: sigCount,
            ownershipsRetained: ownCount,
          },
          sessionId: user.sid,
        });

        return {
          ownerId: id,
          erasedAt: now,
          alreadyErased: false,
          clearedFields,
          signaturesRetained: sigCount,
          ownershipsRetained: ownCount,
        };
      },
      { userId: user.sub },
    );
  }
}
