import { getSetting, upsertSetting } from '../db/repositories/settings-repository.js';

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

export async function getProjectSettings(): Promise<ProjectSettings> {
  const existing = await getSetting(PROJECT_SETTINGS_ID);
  if (existing) return asProjectSettings(existing as Record<string, unknown>);
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

export async function getProjectDefaultAgentKeyId(): Promise<string | null> {
  return (await getProjectSettings()).defaultAgentKeyId;
}

export async function getFallbackModelConfig(): Promise<{
  model: string;
  modelId: string | null;
} | null> {
  const settings = await getProjectSettings();
  if (!settings.fallbackModel) return null;
  return { model: settings.fallbackModel, modelId: settings.fallbackModelId };
}

export async function updateProjectSettings(
  data: {
    defaultAgentKeyId?: string | null;
    fallbackModel?: string | null;
    fallbackModelId?: string | null;
    autoAttachOversizedPasteAsTextFile?: boolean;
  },
): Promise<ProjectSettings> {
  const current = await getProjectSettings();
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

  const saved = upsertSetting(updated as unknown as Record<string, unknown>);
  return asProjectSettings(saved as Record<string, unknown>);
}
