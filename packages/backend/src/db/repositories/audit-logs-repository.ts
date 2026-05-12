import { store } from '../connection.js';
import type { StoreRecord } from '../store.js';

const COLLECTION = 'auditLogs';

export function insertAuditLogRecord(data: StoreRecord): StoreRecord {
  return store.insert(COLLECTION, data);
}

export function listAuditLogRecords(): StoreRecord[] {
  return store.getAll(COLLECTION);
}
