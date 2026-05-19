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
  // `defaults` carries cross-cutting forensic context (ISO 27001 A.12.4 —
  // e.g. source IP / User-Agent) merged into EVERY entry from one place,
  // so callers don't repeat it per .log() and it can't be forgotten. A
  // per-entry value always wins over a default.
  constructor(
    private readonly db: Database,
    private readonly defaults?: Partial<AuditEntry>,
  ) {}

  private merge(entry: AuditEntry): AuditEntry {
    return this.defaults ? ({ ...this.defaults, ...entry } as AuditEntry) : entry;
  }

  async log(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values(toRow(this.merge(entry)));
  }

  async logMany(entries: AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(auditLog).values(entries.map((e) => toRow(this.merge(e))));
  }
}
