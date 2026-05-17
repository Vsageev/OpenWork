import { listBoardCardsByBoardId } from '../db/repositories/boards-cards-repository.js';
import { store } from '../db/index.js';
import type { Board, BoardCard, Card } from '../db/types.js';
import { getAgent } from './agents.js';
import {
  enqueueAgentBatchRun,
  type AgentBatchCardDependencyInput,
  type AgentBatchRunStatus,
  type AgentBatchStageInput,
} from './agent-batch-queue.js';

export interface BoardBatchOptions {
  boardId: string;
  agentId: string;
  prompt?: string;
  cardIds?: string[];
  columnIds?: string[];
  textFilter?: string;
  maxParallel?: number;
  stages?: AgentBatchStageInput[];
  cardDependencies?: AgentBatchCardDependencyInput[];
}

export interface BoardBatchResult {
  runId: string | null;
  status: AgentBatchRunStatus | null;
  total: number;
  queued: number;
  message: string;
}

/**
 * Count how many cards would be included in a batch run with the given filters.
 */
export function countBoardBatchCards(
  boardId: string,
  columnIds?: string[],
  textFilter?: string,
): number {
  let boardCards = listBoardCardsByBoardId(boardId) as unknown as BoardCard[];

  if (columnIds && columnIds.length > 0) {
    const columnSet = new Set(columnIds);
    boardCards = boardCards.filter((bc) => columnSet.has(bc.columnId));
  }

  let cards = boardCards
    .map((bc) => store.getById('cards', bc.cardId) as Card | null)
    .filter((card): card is Card => Boolean(card));

  if (textFilter && textFilter.trim()) {
    const lower = textFilter.trim().toLowerCase();
    cards = cards.filter((card) => card.name.toLowerCase().includes(lower));
  }

  return cards.length;
}

/**
 * Run an agent on all cards in a board with concurrency control.
 * Optionally scoped to specific columns.
 * Returns immediately after setting up the queue — runs happen in the background.
 */
export async function runBoardAgentBatch(options: BoardBatchOptions): Promise<BoardBatchResult> {
  const {
    boardId,
    agentId,
    prompt,
    cardIds,
    columnIds,
    textFilter,
    maxParallel = 3,
    stages,
    cardDependencies,
  } = options;

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  let cards: Card[];

  if (cardIds && cardIds.length > 0) {
    const boardCards = listBoardCardsByBoardId(boardId) as unknown as BoardCard[];
    const boardCardMap = new Map<string, BoardCard>();
    for (const boardCard of boardCards) {
      boardCardMap.set(boardCard.cardId as string, boardCard);
    }

    const seen = new Set<string>();
    cards = cardIds
      .filter((cardId) => {
        if (seen.has(cardId)) return false;
        seen.add(cardId);
        return boardCardMap.has(cardId);
      })
      .map((cardId) => store.getById('cards', cardId) as Card | null)
      .filter((card): card is Card => Boolean(card));
  } else {
    // Get all board cards, optionally filtered by column
    let boardCards = listBoardCardsByBoardId(boardId) as unknown as BoardCard[];

    if (columnIds && columnIds.length > 0) {
      const columnSet = new Set(columnIds);
      boardCards = boardCards.filter((bc) => columnSet.has(bc.columnId));
    }

    // Load card data for each board card
    cards = boardCards
      .map((bc) => store.getById('cards', bc.cardId) as Card | null)
      .filter((card): card is Card => Boolean(card));

    // Filter by card name text
    if (textFilter && textFilter.trim()) {
      const lower = textFilter.trim().toLowerCase();
      cards = cards.filter((card) => card.name.toLowerCase().includes(lower));
    }
  }

  if (cards.length === 0) {
    return {
      runId: null,
      status: null,
      total: 0,
      queued: 0,
      message: 'No cards found on the board',
    };
  }

  const board = store.getById('boards', boardId) as Board | null;
  const result = enqueueAgentBatchRun({
    sourceType: 'board',
    sourceId: boardId,
    sourceName: board?.name ?? null,
    agentId,
    prompt,
    maxParallel,
    stages,
    cardDependencies,
    cards: cards.map((card) => ({
      id: card.id,
      name: card.name,
      description:
        typeof card.description === 'string'
          ? card.description
          : null,
      collectionId: card.collectionId,
    })),
  });

  return result;
}
