import { store } from '../db/index.js';
import { getAgent } from './agents.js';
import { executeCardTask } from './agent-chat.js';

export interface BoardBatchOptions {
  boardId: string;
  agentId: string;
  prompt: string;
  columnIds?: string[];
  maxParallel?: number;
}

export interface BoardBatchResult {
  total: number;
  queued: number;
  message: string;
}

/**
 * Run an agent on all cards in a board with concurrency control.
 * Optionally scoped to specific columns.
 * Returns immediately after setting up the queue — runs happen in the background.
 */
export async function runBoardAgentBatch(options: BoardBatchOptions): Promise<BoardBatchResult> {
  const { boardId, agentId, prompt, columnIds, maxParallel = 3 } = options;

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  // Get all board cards, optionally filtered by column
  let boardCards = store.find('boardCards', (r: any) => r.boardId === boardId) as any[];

  if (columnIds && columnIds.length > 0) {
    const columnSet = new Set(columnIds);
    boardCards = boardCards.filter((bc: any) => columnSet.has(bc.columnId));
  }

  // Load card data for each board card
  const cards = boardCards
    .map((bc: any) => store.getById('cards', bc.cardId) as any)
    .filter(Boolean);

  if (cards.length === 0) {
    return { total: 0, queued: 0, message: 'No cards found on the board' };
  }

  const total = cards.length;
  let activeCount = 0;
  let queueIdx = 0;

  function processNext() {
    while (activeCount < maxParallel && queueIdx < cards.length) {
      const card = cards[queueIdx++];
      activeCount++;

      executeCardTask(
        agentId,
        {
          id: card.id,
          name: card.name,
          description: card.description ?? null,
          collectionId: card.collectionId,
        },
        {
          onDone: () => {
            activeCount--;
            processNext();
          },
          onError: (err) => {
            console.error(`[board-batch] Card ${card.id} (${card.name}) error: ${err}`);
            activeCount--;
            processNext();
          },
        },
        prompt,
      );
    }
  }

  processNext();

  return {
    total,
    queued: total,
    message: `Batch started: processing ${total} card(s) with up to ${maxParallel} parallel agents`,
  };
}
