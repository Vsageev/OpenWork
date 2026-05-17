import cron from 'node-cron';
import { store } from '../db/index.js';
import {
  getBoardCronTemplateRecordById,
  listBoardCronTemplatesForBoard,
  listDistinctBoardIdsFromCronTemplates,
} from '../db/repositories/board-cron-templates-repository.js';
import { createCard, addCardTag } from './cards.js';
import { addCardToBoard, getBoardById } from './boards.js';

export interface BoardCronTemplate {
  id: string;
  boardId: string;
  columnId: string;
  name: string;
  description: string | null;
  assigneeId: string | null;
  tagIds: string[];
  cron: string;
  enabled: boolean;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface BoardCronTemplateWithNextRun extends BoardCronTemplate {
  nextRunAt: string | null;
}

interface RunningBoardCronTask {
  task: cron.ScheduledTask;
  signature: string;
}

// Map keyed by templateId → running scheduled task
const runningTasks = new Map<string, RunningBoardCronTask>();

function templateSignature(t: BoardCronTemplate): string {
  return JSON.stringify({ cron: t.cron, columnId: t.columnId, name: t.name, description: t.description, assigneeId: t.assigneeId, tagIds: t.tagIds });
}

function getTaskNextRunAt(task: cron.ScheduledTask): string | null {
  const nextRun = task.getNextRun();
  return nextRun ? nextRun.toISOString() : null;
}

function getBoardCronTemplateNextRunAt(template: BoardCronTemplate): string | null {
  if (!template.enabled) return null;
  if (!cron.validate(template.cron)) return null;

  const running = runningTasks.get(template.id);
  if (!running) return null;
  if (running.signature !== templateSignature(template)) return null;

  return getTaskNextRunAt(running.task);
}

export function withBoardCronTemplateNextRun(
  template: BoardCronTemplate,
): BoardCronTemplateWithNextRun {
  return {
    ...template,
    nextRunAt: getBoardCronTemplateNextRunAt(template),
  };
}

export async function listBoardCronTemplatesWithNextRun(
  boardId: string,
): Promise<BoardCronTemplateWithNextRun[]> {
  const templates = await listBoardCronTemplates(boardId);
  return templates.map((template) => withBoardCronTemplateNextRun(template as BoardCronTemplate));
}

// ── CRUD ──────────────────────────────────────────────────────────────

export async function listBoardCronTemplates(boardId: string) {
  return (await listBoardCronTemplatesForBoard(boardId)) as unknown as BoardCronTemplate[];
}

export async function getBoardCronTemplate(id: string) {
  return ((await getBoardCronTemplateRecordById(id)) as BoardCronTemplate | null) ?? null;
}

export async function createBoardCronTemplate(
  data: {
    boardId: string;
    columnId: string;
    name: string;
    description?: string | null;
    assigneeId?: string | null;
    tagIds?: string[];
    cron: string;
    enabled?: boolean;
  },
  createdById: string,
) {
  const template = store.insert('boardCronTemplates', {
    boardId: data.boardId,
    columnId: data.columnId,
    name: data.name,
    description: data.description ?? null,
    assigneeId: data.assigneeId ?? null,
    tagIds: data.tagIds ?? [],
    cron: data.cron,
    enabled: data.enabled ?? true,
    createdById,
  }) as unknown as BoardCronTemplate;

  await syncBoardCronJobs(data.boardId);
  return template;
}

export async function updateBoardCronTemplate(
  id: string,
  data: {
    columnId?: string;
    name?: string;
    description?: string | null;
    assigneeId?: string | null;
    tagIds?: string[];
    cron?: string;
    enabled?: boolean;
  },
) {
  const existing = (await getBoardCronTemplateRecordById(id)) as BoardCronTemplate | null;
  if (!existing) return null;

  const setData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setData[key] = value;
    }
  }
  setData.updatedAt = new Date().toISOString();

  const updated = store.update('boardCronTemplates', id, setData) as BoardCronTemplate | null;
  if (!updated) return null;

  await syncBoardCronJobs(existing.boardId);
  return updated;
}

export async function deleteBoardCronTemplate(id: string): Promise<boolean> {
  const existing = (await getBoardCronTemplateRecordById(id)) as BoardCronTemplate | null;
  if (!existing) return false;

  const deleted = store.delete('boardCronTemplates', id);
  if (deleted) {
    const running = runningTasks.get(id);
    if (running) {
      running.task.stop();
      runningTasks.delete(id);
    }
  }
  return !!deleted;
}

// ── Scheduling ────────────────────────────────────────────────────────

async function executeBoardCronTemplate(template: BoardCronTemplate): Promise<void> {
  try {
    const board = await getBoardById(template.boardId);
    if (!board) return;

    const collectionId = board.defaultCollectionId;
    if (!collectionId) return;

    // Create card
    const card = await createCard({
      collectionId,
      name: template.name,
      description: template.description,
      assigneeId: template.assigneeId,
    });

    // Add tags
    if (template.tagIds && template.tagIds.length > 0) {
      for (const tagId of template.tagIds) {
        await addCardTag(card.id, tagId);
      }
    }

    // Place on board
    await addCardToBoard(template.boardId, card.id, template.columnId);
  } catch (err) {
    console.error(`Board cron template ${template.id} execution error:`, err);
  }
}

export async function syncBoardCronJobs(boardId: string): Promise<void> {
  const templates = await listBoardCronTemplates(boardId);

  // Build expected active templates
  const expected = new Map<string, { template: BoardCronTemplate; signature: string }>();
  for (const t of templates) {
    if (!t.enabled) continue;
    if (!cron.validate(t.cron)) continue;
    expected.set(t.id, { template: t, signature: templateSignature(t) });
  }

  // Stop tasks for this board that are no longer needed
  for (const [key, running] of runningTasks.entries()) {
    const tmpl = (await getBoardCronTemplateRecordById(key)) as BoardCronTemplate | null;
    if (!tmpl || tmpl.boardId !== boardId) continue;
    if (!expected.has(key)) {
      running.task.stop();
      runningTasks.delete(key);
    }
  }

  // Start new tasks and reload changed ones
  for (const [key, exp] of expected.entries()) {
    const existing = runningTasks.get(key);
    if (existing && existing.signature === exp.signature) continue;

    if (existing) {
      existing.task.stop();
      runningTasks.delete(key);
    }

    const task = cron.schedule(exp.template.cron, () => {
      void (async () => {
        const current = (await getBoardCronTemplateRecordById(key)) as BoardCronTemplate | null;
        if (current && current.enabled) {
          await executeBoardCronTemplate(current);
        }
      })();
    });
    runningTasks.set(key, { task, signature: exp.signature });
  }
}

export async function stopAllBoardCronJobs(boardId: string): Promise<void> {
  const templates = await listBoardCronTemplates(boardId);
  for (const t of templates) {
    const running = runningTasks.get(t.id);
    if (running) {
      running.task.stop();
      runningTasks.delete(t.id);
    }
  }
}

export async function initAllBoardCronJobs(): Promise<void> {
  const boardIds = await listDistinctBoardIdsFromCronTemplates();
  for (const boardId of boardIds) {
    await syncBoardCronJobs(boardId);
  }
}
