import {
  insertAuditLogRecord,
  listAuditLogRecords,
} from '../db/repositories/audit-logs-repository.js';

type AuditAction = string;

export interface LogEntryParams {
  userId?: string;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuditLogQuery {
  userId?: string;
  entityType?: string;
  entityId?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function createAuditLog(params: LogEntryParams) {
  const entry = await insertAuditLogRecord({
    userId: params.userId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    changes: params.changes,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  return entry;
}

export async function queryAuditLogs(query: AuditLogQuery) {
  const predicate = (r: Record<string, unknown>) => {
    if (query.userId && r.userId !== query.userId) return false;
    if (query.entityType && r.entityType !== query.entityType) return false;
    if (query.entityId && r.entityId !== query.entityId) return false;
    if (query.action && r.action !== query.action) return false;
    if (query.from) {
      const createdAt = new Date(r.createdAt as string);
      if (createdAt < query.from) return false;
    }
    if (query.to) {
      const createdAt = new Date(r.createdAt as string);
      if (createdAt > query.to) return false;
    }
    return true;
  };

  const allMatching = listAuditLogRecords().filter(predicate);
  const total = allMatching.length;

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const sorted = allMatching.sort(
    (a, b) =>
      new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime(),
  );

  const entries = sorted.slice(offset, offset + limit);

  return { entries, total };
}
