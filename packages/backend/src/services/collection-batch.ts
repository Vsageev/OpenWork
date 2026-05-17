import { store } from '../db/index.js';
import type { Card, Collection } from '../db/types.js';
import { listCards } from './cards.js';
import { getAgent } from './agents.js';
import {
  enqueueAgentBatchRun,
  type AgentBatchCardDependencyInput,
  type AgentBatchRunStatus,
  type AgentBatchStageInput,
} from './agent-batch-queue.js';

export interface CollectionBatchCardFilters {
  search?: string;
  assigneeId?: string;

  tagId?: string;
}

export interface CollectionBatchOptions {
  collectionId: string;
  agentId: string;
  prompt?: string;
  maxParallel?: number;
  cardIds?: string[];
  cardFilters?: CollectionBatchCardFilters;
  stages?: AgentBatchStageInput[];
  cardDependencies?: AgentBatchCardDependencyInput[];
}

export interface CollectionBatchResult {
  runId: string | null;
  status: AgentBatchRunStatus | null;
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
  const {
    collectionId,
    agentId,
    prompt,
    maxParallel = 3,
    cardIds,
    cardFilters = {},
    stages,
    cardDependencies,
  } = options;

  const agent = getAgent(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  let cards: Card[];

  if (cardIds && cardIds.length > 0) {
    const seen = new Set<string>();
    cards = cardIds
      .filter((cardId) => {
        if (seen.has(cardId)) return false;
        seen.add(cardId);
        const card = store.getById('cards', cardId) as Card | null;
        return card?.collectionId === collectionId;
      })
      .map((cardId) => store.getById('cards', cardId) as Card | null)
      .filter((card): card is Card => Boolean(card));
  } else {
    // Fetch all matching cards without pagination limit
    const result = await listCards({
      collectionId,
      ...cardFilters,
      limit: 10000,
      offset: 0,
    });
    cards = result.entries as Card[];
  }

  if (cards.length === 0) {
    return {
      runId: null,
      status: null,
      total: 0,
      queued: 0,
      message: 'No cards matched the batch scope',
    };
  }

  const collection = store.getById('collections', collectionId) as Collection | null;
  const result = enqueueAgentBatchRun({
    sourceType: 'collection',
    sourceId: collectionId,
    sourceName: collection?.name ?? null,
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
      collectionId,
    })),
  });

  return result;
}
