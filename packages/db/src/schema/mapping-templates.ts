import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations, users } from './tenancy';

/**
 * Phase 6 S7 / D.34 — Layer-2 saved templates for the Excel import
 * mapping pipeline.
 *
 *   Layer 1: deterministic alias match (apps/worker/src/mapping/mapping.ts).
 *   Layer 2: this table — per-org saved mappings keyed by header
 *            fingerprint (sha256 of normalised headers, sorted).
 *   Layer 3: agent (LLM) normalisation — Phase 7+ proposes a mapping,
 *            manager approves, becomes a Layer-2 row.
 *
 * See migration 0028 for the column-level rationale + RLS + GRANTs.
 * The schema definition here mirrors that migration; drizzle infers
 * the right types so consuming code stays type-safe.
 */
export const mappingTemplates = pgTable(
  'mapping_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /** sha256 of `headers.map(normaliseHeader).sort().join('|')`. */
    fingerprint: text('fingerprint').notNull(),

    /** Optional human-readable label. */
    name: text('name'),

    /** Shape: { columns: { national_id: 0, phone: 1, ... }, headers: [...] }.
     *  jsonb (not typed columns) — see migration 0028 rationale. */
    mapping: jsonb('mapping').notNull().$type<{
      columns: Partial<Record<string, number>>;
      headers: string[];
    }>(),

    /** Provenance: 'manual' | 'agent' | 'system'. Enforced via CHECK. */
    source: text('source').notNull(),

    /** [0, 100] when source='agent'; NULL otherwise. Enforced via CHECK. */
    confidence: numeric('confidence', { precision: 5, scale: 2 }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),

    /** approved_by + approved_at move together (CHECK enforces).
     *  Worker MUST verify approved_by IS NOT NULL before using. */
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    orgFpUniqueActive: uniqueIndex('mapping_templates_org_fp_active')
      .on(table.orgId, table.fingerprint)
      .where(sql`archived_at IS NULL`),
    orgRecentIdx: index('idx_mapping_templates_org_recent')
      .on(table.orgId, table.createdAt.desc())
      .where(sql`archived_at IS NULL`),
    sourceCheck: check(
      'mapping_templates_source_valid',
      sql`${table.source} IN ('manual','agent','system')`,
    ),
    confidenceCheck: check(
      'mapping_templates_confidence_range',
      sql`(${table.source} = 'agent' AND ${table.confidence} IS NOT NULL
           AND ${table.confidence} >= 0 AND ${table.confidence} <= 100)
          OR (${table.source} <> 'agent' AND ${table.confidence} IS NULL)`,
    ),
    approvalPaired: check(
      'mapping_templates_approval_paired',
      sql`(${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL)`,
    ),
  }),
);

export type MappingTemplate = typeof mappingTemplates.$inferSelect;
export type NewMappingTemplate = typeof mappingTemplates.$inferInsert;
