import type { Database } from '../client';
import { auditLog } from '../schema/artifacts';
import type { NewAuditLog } from '../schema/artifacts';

export type ActorType = 'user' | 'system' | 'provider';

export interface AuditEntry {
  orgId: string;
  actorId?: string; // null/undefined = system action
  actorType: ActorType;
  actorEmail?: string;
  action: string;
  targetTable?: string;
  targetId?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

function toRow(entry: AuditEntry): NewAuditLog {
  return {
    orgId: entry.orgId,
    actorId: entry.actorId ?? null,
    actorType: entry.actorType,
    actorEmail: entry.actorEmail ?? null,
    action: entry.action,
    targetTable: entry.targetTable ?? null,
    targetId: entry.targetId ?? null,
    beforeState: entry.beforeState ?? null,
    afterState: entry.afterState ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    sessionId: entry.sessionId ?? null,
    metadata: entry.metadata ?? {},
  };
}

export class AuditService {
  constructor(private readonly db: Database) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values(toRow(entry));
  }

  async logMany(entries: AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(auditLog).values(entries.map(toRow));
  }
}
