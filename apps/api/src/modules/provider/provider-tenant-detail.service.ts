/**
 * D.37 / Phase 6.5 — Provider Admin tenant DETAIL service.
 *
 * `GET /provider/tenants/:id` — single org with extended counts +
 * up to 5 sample owners. Sample owners are returned WITH PII MASKED
 * IN-SQL (current_setting('app.encryption_key') is set by withProvider
 * — v8.5 fix). No cleartext PII ever leaves Postgres; the row that
 * arrives at Node already has the masked strings.
 *
 * PII rules (D.37 + D.19):
 *   - name → `'•••••••' || right(decrypted, 2)`     (e.g. `•••••••ון`)
 *   - phone → `'•••••' || right(decrypted, 4)` or NULL
 *   - national_id → NEVER on the wire. Not even masked. Not even
 *                   length-revealing. The column is not in the SELECT.
 *
 * Audit row written: `action='provider.tenant.viewed'` with
 * `metadata.endpoint='detail'`, `target_table='organizations'`,
 * `target_record_id=<orgId>`. Provider audit search can pivot
 * directly on `target_record_id` to find all detail-views of a
 * specific tenant.
 *
 * 404 semantics: if the org id is not found, throws NotFoundException
 * with code `tenant_not_found` (D.16 envelope). Provider tier doesn't
 * need the "no oracle" treatment org tier uses (cross-org 404) —
 * BYPASSRLS sees everything, so a 404 here genuinely means the row
 * doesn't exist.
 */
import { organizations, withProvider } from '@emapp/db';
import type { TenantDetail, TenantSampleOwner } from '@emapp/shared-types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import type { ProviderPrincipal } from './current-provider.decorator';

// Use a type alias (not interface) so drizzle's `tx.execute<T>` accepts
// it — its constraint is `Record<string, unknown>` and interface
// declarations do NOT satisfy that constraint structurally (the
// well-known TS2344 quirk). Type aliases DO.
type OrgRow = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  archivedAt: Date | null;
  usersCount: number;
  projectsCount: number;
  ownersCount: number;
  importJobsCount: number;
  signatureRequestsCount: number;
};

type SampleOwnerRow = {
  id: string;
  nameMasked: string;
  email: string | null;
  phoneMasked: string | null;
  archivedAt: Date | null;
};

@Injectable()
export class ProviderTenantDetailService {
  async get(actor: ProviderPrincipal, reason: string, tenantId: string): Promise<TenantDetail> {
    const result = await withProvider(
      actor.sub,
      reason,
      async (tx) => {
        // Single query for the org + 5 counts. Same correlated-subquery
        // pattern as the LIST endpoint, extended with importJobs +
        // signatureRequests for the detail view.
        const orgRows = await tx.execute<OrgRow>(sql`
          SELECT
            o.id AS "id",
            o.name AS "name",
            o.slug AS "slug",
            o.created_at AS "createdAt",
            o.archived_at AS "archivedAt",
            (
              SELECT COUNT(*)::int FROM users u
              INNER JOIN memberships m ON m.user_id = u.id
              WHERE m.org_id = o.id
                AND m.revoked_at IS NULL
                AND u.archived_at IS NULL
            ) AS "usersCount",
            (
              SELECT COUNT(*)::int FROM projects p
              WHERE p.org_id = o.id AND p.archived_at IS NULL
            ) AS "projectsCount",
            (
              SELECT COUNT(*)::int FROM owners w
              WHERE w.org_id = o.id AND w.archived_at IS NULL
            ) AS "ownersCount",
            (
              SELECT COUNT(*)::int FROM import_jobs j
              WHERE j.org_id = o.id
            ) AS "importJobsCount",
            (
              SELECT COUNT(*)::int FROM signature_requests s
              WHERE s.org_id = o.id
            ) AS "signatureRequestsCount"
          FROM ${organizations} o
          WHERE o.id = ${tenantId}
          LIMIT 1
        `);
        const org = orgRows.rows[0];
        if (!org) return null;

        // 5 most-recently-created owners with PII MASKED IN-SQL.
        // pgp_sym_decrypt runs server-side via the GUC; the bytea
        // ciphertext is NEVER serialized to Node. The masking
        // expressions return cooked strings or NULL — same pattern
        // owners.service.ts uses for the org tier list (NID_MASK /
        // PHONE_MASK / NAME_DECRYPTED), adapted for D.37:
        //   - name → first-7-bullets + last-2-chars
        //   - phone → 5-bullets + last-4
        //   - national_id is NEVER in this SELECT — column omitted.
        const sampleRows = await tx.execute<SampleOwnerRow>(sql`
          SELECT
            id AS "id",
            ('•••••••' || right(pgp_sym_decrypt(name_encrypted, current_setting('app.encryption_key'))::text, 2)) AS "nameMasked",
            email AS "email",
            CASE
              WHEN phone_encrypted IS NULL THEN NULL
              ELSE '•••••' || right(pgp_sym_decrypt(phone_encrypted, current_setting('app.encryption_key'))::text, 4)
            END AS "phoneMasked",
            archived_at AS "archivedAt"
          FROM owners
          WHERE org_id = ${tenantId}
          ORDER BY created_at DESC, id DESC
          LIMIT 5
        `);

        return { org, sampleOwners: sampleRows.rows };
      },
      {
        ip: actor.ip,
        userAgent: actor.userAgent,
        targetTable: 'organizations',
        targetRecordId: tenantId,
        action: 'provider.tenant.viewed',
        metadata: {
          endpoint: 'detail',
          tenantId,
        },
      },
    );

    if (!result) {
      throw new NotFoundException({
        error: {
          code: 'tenant_not_found',
          message: `No tenant found for id`,
        },
      });
    }

    const sampleOwners: TenantSampleOwner[] = result.sampleOwners.map((r) => ({
      id: r.id,
      nameMasked: r.nameMasked,
      email: r.email,
      phoneMasked: r.phoneMasked,
      archivedAt: r.archivedAt,
    }));

    return {
      id: result.org.id,
      name: result.org.name,
      slug: result.org.slug,
      createdAt: result.org.createdAt,
      archivedAt: result.org.archivedAt,
      counts: {
        users: Number(result.org.usersCount),
        projects: Number(result.org.projectsCount),
        owners: Number(result.org.ownersCount),
        importJobs: Number(result.org.importJobsCount),
        signatureRequests: Number(result.org.signatureRequestsCount),
      },
      sampleOwners,
    };
  }
}

// Suppress unused-import lint flag — `eq` is the canonical drizzle
// helper for FKs; retained for future variant queries.
void eq;
