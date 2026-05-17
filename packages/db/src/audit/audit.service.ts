import type { Database } from '../client';
import { auditLog } from '../schema/artifacts';
import type { NewAuditLog } from '../schema/artifacts';

export interface AuditEntry {
  orgId: string;
  actorUserId?: string;
  actorContractorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly db: Database) {}

  async log(entry: AuditEntry): Promise<void> {
    const row: NewAuditLog = {
      orgId: entry.orgId,
      actorUserId: entry.actorUserId ?? null,
      actorContractorId: entry.actorContractorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      metadata: entry.metadata ?? {},
    };
    await this.db.insert(auditLog).values(row);
  }

  async logMany(entries: AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const rows: NewAuditLog[] = entries.map((entry) => ({
      orgId: entry.orgId,
      actorUserId: entry.actorUserId ?? null,
      actorContractorId: entry.actorContractorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      metadata: entry.metadata ?? {},
    }));
    await this.db.insert(auditLog).values(rows);
  }
}
