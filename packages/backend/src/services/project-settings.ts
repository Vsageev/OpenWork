import { store } from '../db/index.js';

const SETTINGS_COLLECTION = 'settings';
const PROJECT_SETTINGS_ID = 'project';

export interface ProjectSettings {
  id: string;
  defaultAgentKeyId: string | null;
  fallbackModel: string | null;
  fallbackModelId: string | null;
  autoAttachOversizedPasteAsTextFile: boolean;
  createdAt: string;
  updatedAt: string;
}

function asProjectSettings(rec: Record<string, unknown>): ProjectSettings {
  const defaultAgentKeyId =
    typeof rec.defaultAgentKeyId === 'string' && rec.defaultAgentKeyId.length > 0
      ? rec.defaultAgentKeyId
      : null;
  const fallbackModel =
    typeof rec.fallbackModel === 'string' && rec.fallbackModel.length > 0
      ? rec.fallbackModel
      : null;
  const fallbackModelId =
    typeof rec.fallbackModelId === 'string' && rec.fallbackModelId.length > 0
      ? rec.fallbackModelId
      : null;
  const autoAttachOversizedPasteAsTextFile =
    typeof rec.autoAttachOversizedPasteAsTextFile === 'boolean'
      ? rec.autoAttachOversizedPasteAsTextFile
      : typeof rec.autoConvertLargePastedTextToAttachment === 'boolean'
        ? rec.autoConvertLargePastedTextToAttachment
      : true;

  return {
    id: typeof rec.id === 'string' ? rec.id : PROJECT_SETTINGS_ID,
    defaultAgentKeyId,
    fallbackModel,
    fallbackModelId,
    autoAttachOversizedPasteAsTextFile,
    createdAt:
      typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
    updatedAt:
      typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date().toISOString(),
  };
}

export function getProjectSettings(): ProjectSettings {
  const existing = store.getById(SETTINGS_COLLECTION, PROJECT_SETTINGS_ID) as ProjectSettings | null;
  if (existing) return asProjectSettings(existing as unknown as Record<string, unknown>);
  return {
    id: PROJECT_SETTINGS_ID,
    defaultAgentKeyId: null,
    fallbackModel: null,
    fallbackModelId: null,
    autoAttachOversizedPasteAsTextFile: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function getProjectDefaultAgentKeyId(): string | null {
  return getProjectSettings().defaultAgentKeyId;
}

export function getFallbackModelConfig(): { model: string; modelId: string | null } | null {
  const settings = getProjectSettings();
  if (!settings.fallbackModel) return null;
  return { model: settings.fallbackModel, modelId: settings.fallbackModelId };
}

export function updateProjectSettings(
  data: {
    defaultAgentKeyId?: string | null;
    fallbackModel?: string | null;
    fallbackModelId?: string | null;
    autoAttachOversizedPasteAsTextFile?: boolean;
  },
): ProjectSettings {
  const existing = store.getById(SETTINGS_COLLECTION, PROJECT_SETTINGS_ID);
  const current = getProjectSettings();
  const updated = {
    ...current,
    ...(data.defaultAgentKeyId !== undefined
      ? { defaultAgentKeyId: data.defaultAgentKeyId }
      : {}),
    ...(data.fallbackModel !== undefined
      ? { fallbackModel: data.fallbackModel }
      : {}),
    ...(data.fallbackModelId !== undefined
      ? { fallbackModelId: data.fallbackModelId }
      : {}),
    ...(data.autoAttachOversizedPasteAsTextFile !== undefined
      ? {
          autoAttachOversizedPasteAsTextFile: data.autoAttachOversizedPasteAsTextFile,
        }
      : {}),
  };

  if (existing) {
    const saved = store.update(
      SETTINGS_COLLECTION,
      PROJECT_SETTINGS_ID,
      updated as unknown as Record<string, unknown>,
    );
    return asProjectSettings(saved as Record<string, unknown>);
  }

  const created = store.insert(
    SETTINGS_COLLECTION,
    updated as unknown as Record<string, unknown>,
  );
  return asProjectSettings(created);
}
