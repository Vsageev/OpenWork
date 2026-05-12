import { store } from '../db/index.js';
import { getConnectorRecordById, listConnectorRecords } from '../db/repositories/connectors-repository.js';
import { getAdapter, type AuditCtx } from './connector-adapters/index.js';

function enrich(connector: Record<string, unknown>) {
  const adapter = getAdapter(connector.type as string);
  const live = adapter.getStatus(connector.integrationId as string);
  return {
    ...connector,
    status: live.status,
    statusMessage: live.statusMessage,
    settings: live.settings,
  };
}

export async function listConnectors() {
  const rows = await listConnectorRecords();
  return rows.map(enrich);
}

export async function getConnectorById(id: string) {
  const connector = await getConnectorRecordById(id);
  if (!connector) return null;
  return enrich(connector);
}

export async function createConnector(
  type: string,
  payload: Record<string, unknown>,
  audit?: AuditCtx,
) {
  const adapter = getAdapter(type);
  const seed = await adapter.connect(payload, audit);

  const connector = store.insert('connectors', {
    type,
    name: seed.name,
    status: seed.status,
    statusMessage: seed.statusMessage,
    capabilities: seed.capabilities,
    integrationId: seed.integrationId,
    config: seed.config,
  });

  return enrich(connector);
}

export async function deleteConnector(id: string, audit?: AuditCtx) {
  const connector = await getConnectorRecordById(id);
  if (!connector) return null;

  const adapter = getAdapter(connector.type as string);
  await adapter.disconnect(connector.integrationId as string, audit);

  return store.delete('connectors', id);
}

export async function refreshConnector(id: string, audit?: AuditCtx) {
  const connector = await getConnectorRecordById(id);
  if (!connector) return null;

  const adapter = getAdapter(connector.type as string);
  const live = await adapter.refresh(connector.integrationId as string, audit);

  store.update('connectors', id, {
    status: live.status,
    statusMessage: live.statusMessage,
  });

  return enrich((await getConnectorRecordById(id))!);
}

export async function updateConnectorSettings(
  id: string,
  settings: Record<string, unknown>,
  audit?: AuditCtx,
) {
  const connector = await getConnectorRecordById(id);
  if (!connector) return null;

  const adapter = getAdapter(connector.type as string);
  await adapter.updateSettings(connector.integrationId as string, settings, audit);

  return enrich((await getConnectorRecordById(id))!);
}
