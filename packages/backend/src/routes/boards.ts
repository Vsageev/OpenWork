import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { requirePermission } from '../middleware/rbac.js';
import { ApiError } from '../utils/api-errors.js';
import {
  listBoards,
  getBoardById,
  isGeneralBoard,
  countGeneralBoards,
  getBoardWithCards,
  createBoard,
  updateBoard,
  deleteBoard,
  createColumn,
  updateColumn,
  deleteColumn,
  addCardToBoard,
  moveCardOnBoard,
  removeCardFromBoard,
  clearBoardCards,
} from '../services/boards.js';
import { getWorkspaceById } from '../services/workspaces.js';
import {
  cancelAgentBatchRun,
  getAgentBatchRun,
  listAgentBatchRunItems,
  listAgentBatchRuns,
  type AgentBatchItemStatus,
  type AgentBatchRunFilterStatus,
} from '../services/agent-batch-queue.js';
import {
  listBoardCronTemplates,
  createBoardCronTemplate,
  updateBoardCronTemplate,
  deleteBoardCronTemplate,
} from '../services/board-cron.js';
import { runBoardAgentBatch, countBoardBatchCards } from '../services/board-batch.js';

const columnSchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().max(7).optional(),
  position: z.number().int().min(0),
  assignAgentId: z.uuid().nullable().optional(),
  wipLimit: z.number().int().min(1).nullable().optional(),
});

const createBoardBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  collectionId: z.uuid().nullable().optional(),
  defaultCollectionId: z.uuid().nullable().optional(),
  columns: z.array(columnSchema).optional(),
});

const updateBoardBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  collectionId: z.uuid().nullable().optional(),
  defaultCollectionId: z.uuid().nullable().optional(),
});

const batchRunStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'active']);
const batchItemStatusSchema = z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']);

export async function boardRoutes(app: FastifyInstance) {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // List boards
  typedApp.get(
    '/api/boards',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'List boards',
        querystring: z.object({
          collectionId: z.uuid().optional(),
          workspaceId: z.uuid().optional(),
          search: z.string().optional(),
          limit: z.coerce.number().optional(),
          offset: z.coerce.number().optional(),
        }),
      },
    },
    async (request, reply) => {
      let ids: string[] | undefined;
      if (request.query.workspaceId) {
        const workspace = await getWorkspaceById(request.query.workspaceId) as any;
        if (workspace) {
          ids = workspace.boardIds;
        }
      }

      const { entries, total } = await listBoards({
        ids,
        collectionId: request.query.collectionId,
        search: request.query.search,
        limit: request.query.limit,
        offset: request.query.offset,
      });

      return reply.send({
        total,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  // Get single board (with columns)
  typedApp.get(
    '/api/boards/:id',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'Get a single board with columns',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const board = await getBoardWithCards(request.params.id);
      if (!board) {
        return reply.notFound('Board not found');
      }
      return reply.send(board);
    },
  );

  // Create board
  typedApp.post(
    '/api/boards',
    {
      onRequest: [app.authenticate, requirePermission('boards:create')],
      schema: {
        tags: ['Boards'],
        summary: 'Create a new board',
        body: createBoardBody,
      },
    },
    async (request, reply) => {
      const board = await createBoard(request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(201).send(board);
    },
  );

  // Update board
  typedApp.patch(
    '/api/boards/:id',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Update an existing board',
        params: z.object({ id: z.uuid() }),
        body: updateBoardBody,
      },
    },
    async (request, reply) => {
      const updated = await updateBoard(request.params.id, request.body, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!updated) {
        return reply.notFound('Board not found');
      }

      return reply.send(updated);
    },
  );

  // Delete board
  typedApp.delete(
    '/api/boards/:id',
    {
      onRequest: [app.authenticate, requirePermission('boards:delete')],
      schema: {
        tags: ['Boards'],
        summary: 'Delete a board',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) {
        return reply.notFound('Board not found');
      }

      if (isGeneralBoard(board)) {
        const generalCount = await countGeneralBoards();
        if (generalCount <= 1) {
          throw ApiError.conflict(
            'general_board_protected',
            'The last remaining general board cannot be deleted',
            'Create and use another board if you need to remove this one',
          );
        }
      }

      const deleted = await deleteBoard(request.params.id, {
        userId: request.user.sub,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      if (!deleted) {
        return reply.notFound('Board not found');
      }

      return reply.status(204).send();
    },
  );

  // ── Column operations ──────────────────────────────────────────────

  // Add column to board
  typedApp.post(
    '/api/boards/:id/columns',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Add a column to a board',
        params: z.object({ id: z.uuid() }),
        body: columnSchema,
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) {
        return reply.notFound('Board not found');
      }

      const column = await createColumn(request.params.id, request.body);
      return reply.status(201).send(column);
    },
  );

  // Update column
  typedApp.patch(
    '/api/boards/:id/columns/:columnId',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Update a board column',
        params: z.object({ id: z.uuid(), columnId: z.uuid() }),
        body: z.object({
          name: z.string().min(1).max(255).optional(),
          color: z.string().max(7).optional(),
          position: z.number().int().min(0).optional(),
          assignAgentId: z.uuid().nullable().optional(),
          wipLimit: z.number().int().min(1).nullable().optional(),
        }),
      },
    },
    async (request, reply) => {
      const updated = await updateColumn(request.params.columnId, request.body);
      if (!updated) {
        return reply.notFound('Column not found');
      }

      return reply.send(updated);
    },
  );

  // Delete column
  typedApp.delete(
    '/api/boards/:id/columns/:columnId',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Delete a board column',
        params: z.object({ id: z.uuid(), columnId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = await deleteColumn(request.params.columnId);
      if (!deleted) {
        return reply.notFound('Column not found');
      }

      return reply.status(204).send();
    },
  );

  // ── Board-Card placement ───────────────────────────────────────────

  // Add card to board
  typedApp.post(
    '/api/boards/:id/cards',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Place a card on a board',
        params: z.object({ id: z.uuid() }),
        body: z.object({
          cardId: z.uuid(),
          columnId: z.uuid(),
          position: z.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) {
        return reply.notFound('Board not found');
      }

      const boardCard = await addCardToBoard(
        request.params.id,
        request.body.cardId,
        request.body.columnId,
        request.body.position,
      );

      return reply.status(201).send(boardCard);
    },
  );

  // Move card between columns
  typedApp.patch(
    '/api/boards/:id/cards/:cardId',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Move a card to a different column',
        params: z.object({ id: z.uuid(), cardId: z.uuid() }),
        body: z.object({
          columnId: z.uuid(),
          position: z.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const moved = await moveCardOnBoard(
        request.params.id,
        request.params.cardId,
        request.body.columnId,
        request.body.position,
      );

      if (!moved) {
        return reply.notFound('Card not found on this board');
      }

      return reply.send(moved);
    },
  );

  // Remove card from board
  typedApp.delete(
    '/api/boards/:id/cards/:cardId',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Remove a card from a board',
        params: z.object({ id: z.uuid(), cardId: z.uuid() }),
      },
    },
    async (request, reply) => {
      await removeCardFromBoard(request.params.id, request.params.cardId);

      return reply.status(204).send();
    },
  );

  // Remove all cards from board
  typedApp.delete(
    '/api/boards/:id/cards',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Remove all cards from a board',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) {
        return reply.notFound('Board not found');
      }

      await clearBoardCards(request.params.id);

      return reply.status(204).send();
    },
  );

  // ── Cron Templates ────────────────────────────────────────────────

  // List cron templates for a board
  typedApp.get(
    '/api/boards/:id/cron-templates',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'List cron templates for a board',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const entries = listBoardCronTemplates(request.params.id);
      return reply.send({ entries, total: entries.length });
    },
  );

  // Create cron template
  typedApp.post(
    '/api/boards/:id/cron-templates',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Create a cron template for a board',
        params: z.object({ id: z.uuid() }),
        body: z.object({
          columnId: z.uuid(),
          name: z.string().min(1).max(255),
          description: z.string().nullable().optional(),
          assigneeId: z.uuid().nullable().optional(),
          tagIds: z.array(z.uuid()).optional(),
          cron: z.string().min(9).max(100),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const template = createBoardCronTemplate(
        { ...request.body, boardId: request.params.id },
        request.user.sub,
      );

      return reply.status(201).send(template);
    },
  );

  // Update cron template
  typedApp.patch(
    '/api/boards/:id/cron-templates/:templateId',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Update a cron template',
        params: z.object({ id: z.uuid(), templateId: z.uuid() }),
        body: z.object({
          columnId: z.uuid().optional(),
          name: z.string().min(1).max(255).optional(),
          description: z.string().nullable().optional(),
          assigneeId: z.uuid().nullable().optional(),
          tagIds: z.array(z.uuid()).optional(),
          cron: z.string().min(9).max(100).optional(),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const updated = updateBoardCronTemplate(request.params.templateId, request.body);
      if (!updated) return reply.notFound('Cron template not found');
      return reply.send(updated);
    },
  );

  // ── Batch Run ──────────────────────────────────────────────────────

  typedApp.get(
    '/api/boards/batch-runs',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'List batch runs across all boards',
        querystring: z.object({
          status: batchRunStatusSchema.optional(),
          agentId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const { entries, total } = listAgentBatchRuns({
        sourceType: 'board',
        status: request.query.status as AgentBatchRunFilterStatus | undefined,
        agentId: request.query.agentId,
        limit: request.query.limit,
        offset: request.query.offset,
      });

      return reply.send({
        total,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  typedApp.post(
    '/api/boards/batch-runs/:runId/cancel',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Cancel a board batch run by ID',
        params: z.object({ runId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const run = getAgentBatchRun(request.params.runId);
      if (!run || run.sourceType !== 'board') {
        return reply.notFound('Batch run not found');
      }

      const cancelled = cancelAgentBatchRun(request.params.runId);
      return reply.send(cancelled ?? run);
    },
  );

  // Preview how many cards match the batch run filters
  typedApp.get(
    '/api/boards/:id/batch-run/preview',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'Preview card count for a batch run',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          columnIds: z.string().optional(),
          textFilter: z.string().max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const columnIds = request.query.columnIds
        ? request.query.columnIds.split(',').filter(Boolean)
        : undefined;

      const count = countBoardBatchCards(
        request.params.id,
        columnIds,
        request.query.textFilter,
      );

      return reply.send({ count });
    },
  );

  // Run an agent on all cards in a board
  typedApp.post(
    '/api/boards/:id/batch-run',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Run an agent on all cards in a board',
        params: z.object({ id: z.uuid() }),
        body: z.object({
          agentId: z.uuid(),
          prompt: z.string().min(1).max(10000),
          columnIds: z.array(z.uuid()).optional(),
          textFilter: z.string().max(200).optional(),
          maxParallel: z.number().int().min(1).max(10).optional(),
        }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const result = await runBoardAgentBatch({
        boardId: request.params.id,
        ...request.body,
      });

      return reply.send(result);
    },
  );

  typedApp.get(
    '/api/boards/:id/batch-runs',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'List batch runs for a board',
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          status: batchRunStatusSchema.optional(),
          agentId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const { entries, total } = listAgentBatchRuns({
        sourceType: 'board',
        sourceId: request.params.id,
        status: request.query.status as AgentBatchRunFilterStatus | undefined,
        agentId: request.query.agentId,
        limit: request.query.limit,
        offset: request.query.offset,
      });

      return reply.send({
        total,
        limit: request.query.limit ?? 50,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  typedApp.get(
    '/api/boards/:id/batch-runs/:runId',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'Get a board batch run',
        params: z.object({ id: z.uuid(), runId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const run = getAgentBatchRun(request.params.runId);
      if (!run) return reply.notFound('Batch run not found');
      if (run.sourceType !== 'board' || run.sourceId !== request.params.id) {
        return reply.notFound('Batch run not found');
      }

      return reply.send(run);
    },
  );

  typedApp.get(
    '/api/boards/:id/batch-runs/:runId/items',
    {
      onRequest: [app.authenticate, requirePermission('boards:read')],
      schema: {
        tags: ['Boards'],
        summary: 'List board batch run items',
        params: z.object({ id: z.uuid(), runId: z.uuid() }),
        querystring: z.object({
          status: batchItemStatusSchema.optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const run = getAgentBatchRun(request.params.runId);
      if (!run) return reply.notFound('Batch run not found');
      if (run.sourceType !== 'board' || run.sourceId !== request.params.id) {
        return reply.notFound('Batch run not found');
      }

      const { entries, total } = listAgentBatchRunItems(request.params.runId, {
        status: request.query.status as AgentBatchItemStatus | undefined,
        limit: request.query.limit,
        offset: request.query.offset,
      });

      return reply.send({
        total,
        limit: request.query.limit ?? 100,
        offset: request.query.offset ?? 0,
        entries,
      });
    },
  );

  typedApp.post(
    '/api/boards/:id/batch-runs/:runId/cancel',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Cancel a board batch run',
        params: z.object({ id: z.uuid(), runId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const board = await getBoardById(request.params.id);
      if (!board) return reply.notFound('Board not found');

      const run = getAgentBatchRun(request.params.runId);
      if (!run) return reply.notFound('Batch run not found');
      if (run.sourceType !== 'board' || run.sourceId !== request.params.id) {
        return reply.notFound('Batch run not found');
      }

      const cancelled = cancelAgentBatchRun(request.params.runId);
      return reply.send(cancelled ?? run);
    },
  );

  // Delete cron template
  typedApp.delete(
    '/api/boards/:id/cron-templates/:templateId',
    {
      onRequest: [app.authenticate, requirePermission('boards:update')],
      schema: {
        tags: ['Boards'],
        summary: 'Delete a cron template',
        params: z.object({ id: z.uuid(), templateId: z.uuid() }),
      },
    },
    async (request, reply) => {
      const deleted = deleteBoardCronTemplate(request.params.templateId);
      if (!deleted) return reply.notFound('Cron template not found');
      return reply.status(204).send();
    },
  );
}
