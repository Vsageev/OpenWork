import { listCards } from './cards.js';
import { getAgent } from './agents.js';
import { executeCardTask } from './agent-chat.js';

export interface CollectionBatchCardFilters {
  search?: string;
  assigneeId?: string;
  completed?: boolean;
  priority?: 'high' | 'medium' | 'low';
  tagId?: string;
}

export interface CollectionBatchOptions {
  collectionId: string;
  agentId: string;
  prompt: string;
  maxParallel?: number;
  cardFilters?: CollectionBatchCardFilters;
}

export interface CollectionBatchResult {
  total: number;
  queued: number;
  message: string;
}

/**
 * Run an agent on all matching cards in a collection with concurrency control.
 * Returns immediately after setting up the queue — runs happen in the background.
 */
export async function runCollectionAgentBatch(
  options: CollectionBatchOptions,
): Promise<CollectionBatchResult> {
  const { collectionId, agentId, prompt, maxParallel = 3, cardFilters = {} } = options;

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  // Fetch all matching cards without pagination limit
  const { entries: cards } = await listCards({
    collectionId,
    ...cardFilters,
    limit: 10000,
    offset: 0,
  });

  if (cards.length === 0) {
    return { total: 0, queued: 0, message: 'No cards matched the filters' };
  }

  const total = cards.length;
  let activeCount = 0;
  let queueIdx = 0;

  // Process cards with a sliding-window concurrency controller
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
          collectionId,
        },
        {
          onDone: () => {
            activeCount--;
            processNext();
          },
          onError: (err) => {
            console.error(`[collection-batch] Card ${card.id} (${card.name}) error: ${err}`);
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
