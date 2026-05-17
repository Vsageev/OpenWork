import {
  clearAgentRunCardReferences,
  deleteBatchRunItemsForCard,
} from '../db/repositories/agent-execution-repository.js';
import {
  deleteCardCommentsByCardId,
  deleteCardLinksForCard,
  deleteCardTagPair,
  deleteBoardCardsByCardId,
  deleteCardTagsByCardId,
  findBidirectionalCardLink,
  findCardTag,
  listBoardCardsByCardId,
  listCardCommentsByCardId,
  listCardLinksBySourceCard,
  listCardLinksByTargetCard,
  listCardTagsByCardId,
  countCardsByCollectionIdNative,
  listCardsNative,
} from '../db/repositories/boards-cards-repository.js';
import { store } from '../db/index.js';
import type { Board, BoardCard, BoardColumn, Card, CardComment, CardLink, CardTag, Tag, User } from '../db/types.js';
import { createAuditLog } from './audit-log.js';
import { getAgent, type AgentRecord } from './agents.js';
import { executeCardTask } from './agent-chat.js';

export interface CardListQuery {
  collectionId?: string;
  assigneeId?: string;
  search?: string;
  tagId?: string;
  limit?: number;
  offset?: number;
}

export interface CreateCardData {
  collectionId: string;
  name: string;
  description?: string | null;
  customFields?: Record<string, unknown>;
  assigneeId?: string | null;
  position?: number;
}

export interface UpdateCardData {
  name?: string;
  description?: string | null;
  customFields?: Record<string, unknown>;
  assigneeId?: string | null;
  collectionId?: string;
  position?: number;
}

interface UpdateCardOptions {
  assignmentPrompt?: string;
}

type CardAssignee =
  | {
      id: string;
      firstName: string;
      lastName: string;
      type: 'user';
    }
  | {
      id: string;
      firstName: string;
      lastName: '';
      type: 'agent';
      avatarIcon: string | null;
      avatarBgColor: string | null;
      avatarLogoColor: string | null;
    }
  | null;

type CardTagSummary = Pick<Tag, 'id' | 'name' | 'color'>;

interface CardBoardPlacement {
  boardId: string;
  boardName: string;
  columnId: string;
  columnName: string | null;
  columnColor: string | null;
}

interface LinkedCardSummary {
  linkId: string;
  id: string;
  name: string;
  collectionId: string;
}

function asCardTagSummary(tag: Tag): CardTagSummary {
  return { id: tag.id, name: tag.name, color: tag.color };
}

export async function listCards(query: CardListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const { entries, total } = await listCardsNative({ ...query, limit, offset });

  // Hydrate assignee and tags for list entries
  const hydrated = (entries as unknown as Card[]).map((card) => {
    let assignee: CardAssignee = null;
    if (card.assigneeId) {
      const user = store.getById('users', card.assigneeId) as User | null;
      if (user) {
        assignee = { id: user.id, firstName: user.firstName, lastName: user.lastName, type: 'user' as const };
      } else {
        const agent = store.getById('agents', card.assigneeId) as AgentRecord | null;
        if (agent) {
          assignee = {
            id: agent.id, firstName: agent.name, lastName: '', type: 'agent' as const,
            avatarIcon: agent.avatarIcon ?? null, avatarBgColor: agent.avatarBgColor ?? null, avatarLogoColor: agent.avatarLogoColor ?? null,
          };
        }
      }
    }

    const cardTags = listCardTagsByCardId(card.id) as unknown as CardTag[];
    const tags = cardTags
      .map((ct) => store.getById('tags', ct.tagId) as Tag | null)
      .filter((tag): tag is Tag => Boolean(tag))
      .map(asCardTagSummary);

    // Load board placements
    const boardCards = listBoardCardsByCardId(card.id) as unknown as BoardCard[];
    const boards: CardBoardPlacement[] = [];
    for (const bc of boardCards) {
      const board = store.getById('boards', bc.boardId) as Board | null;
      if (!board) continue;
      const column = store.getById('boardColumns', bc.columnId) as BoardColumn | null;
      boards.push({
        boardId: board.id,
        boardName: board.name,
        columnId: bc.columnId,
        columnName: column?.name ?? null,
        columnColor: column?.color ?? null,
      });
    }

    return { ...card, assignee, tags, boards };
  });

  return { entries: hydrated, total };
}

export async function getCardById(id: string) {
  const card = store.getById('cards', id) as Card | null;
  if (!card) return null;

  // Load tags
  const cardTags = listCardTagsByCardId(id) as unknown as CardTag[];
  const tagIds = cardTags.map((ct) => ct.tagId);
  const tags = tagIds
    .map((tid) => store.getById('tags', tid) as Tag | null)
    .filter((tag): tag is Tag => Boolean(tag));

  // Load assignee
  let assignee: CardAssignee = null;
  if (card.assigneeId) {
    const user = store.getById('users', card.assigneeId) as User | null;
    if (user) {
      assignee = { id: user.id, firstName: user.firstName, lastName: user.lastName, type: 'user' as const };
    } else {
      const agentRec = store.getById('agents', card.assigneeId) as AgentRecord | null;
      if (agentRec) {
        assignee = {
          id: agentRec.id, firstName: agentRec.name, lastName: '', type: 'agent' as const,
          avatarIcon: agentRec.avatarIcon ?? null, avatarBgColor: agentRec.avatarBgColor ?? null, avatarLogoColor: agentRec.avatarLogoColor ?? null,
        };
      }
    }
  }

  // Load linked cards
  const outgoing = listCardLinksBySourceCard(id) as unknown as CardLink[];
  const incoming = listCardLinksByTargetCard(id) as unknown as CardLink[];

  const linkedCards: LinkedCardSummary[] = [];
  for (const link of outgoing) {
    const target = store.getById('cards', link.targetCardId) as Card | null;
    if (target) {
      linkedCards.push({ linkId: link.id, id: target.id, name: target.name, collectionId: target.collectionId });
    }
  }
  for (const link of incoming) {
    const source = store.getById('cards', link.sourceCardId) as Card | null;
    if (source) {
      // Avoid duplicates if link exists both ways
      if (!linkedCards.some((lc) => lc.id === source.id)) {
        linkedCards.push({ linkId: link.id, id: source.id, name: source.name, collectionId: source.collectionId });
      }
    }
  }

  // Load board placements
  const boardCards = listBoardCardsByCardId(id) as unknown as BoardCard[];
  const boards: CardBoardPlacement[] = [];
  for (const bc of boardCards) {
    const board = store.getById('boards', bc.boardId) as Board | null;
    if (!board) continue;
    const column = store.getById('boardColumns', bc.columnId) as BoardColumn | null;
    boards.push({
      boardId: board.id,
      boardName: board.name,
      columnId: bc.columnId,
      columnName: column?.name ?? null,
      columnColor: column?.color ?? null,
    });
  }

  return { ...card, tags, assignee, linkedCards, boards };
}

export async function createCard(
  data: CreateCardData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  // Auto-calculate position if not provided
    let position = data.position;
  if (position === undefined) {
    position = await countCardsByCollectionIdNative(data.collectionId);
  }

  const card = await store.insert('cards', {
    collectionId: data.collectionId,
    name: data.name,
    description: data.description ?? null,
    customFields: data.customFields ?? {},
    assigneeId: data.assigneeId ?? null,
    position,
    createdById: audit?.userId,
  }) as unknown as Card;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'card',
      entityId: card.id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  // Trigger agent if assigned to an active agent at creation time
  if (data.assigneeId) {
    const agent = getAgent(data.assigneeId);
    if (agent && agent.status === 'active') {
      executeCardTask(agent.id, {
        id: card.id,
        name: card.name,
        description: card.description,
        collectionId: card.collectionId,
      }, {
        onDone: () => {},
        onError: (err) => console.error(`Agent task error for card ${card.id}:`, err),
      });
    }
  }

  return card;
}

export async function updateCard(
  id: string,
  data: UpdateCardData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
  options?: UpdateCardOptions,
) {
  // Capture current assignee before updating so we can detect changes
  const current = store.getById('cards', id) as Card | null;
  if (!current) return null;
  const prevAssigneeId = current.assigneeId;

  const setData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setData[key] = value;
    }
  }
  setData.updatedAt = new Date().toISOString();

  const updated = await store.update('cards', id, setData);
  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'card',
      entityId: id,
      changes: data as unknown as Record<string, unknown>,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  // Trigger agent if assignee changed to an active agent
  if (data.assigneeId !== undefined && data.assigneeId && data.assigneeId !== prevAssigneeId) {
    const agent = getAgent(data.assigneeId);
    if (agent && agent.status === 'active') {
      const refreshed = updated as unknown as Card;
      executeCardTask(agent.id, {
        id,
        name: refreshed.name,
        description: refreshed.description,
        collectionId: refreshed.collectionId,
      }, {
        onDone: () => {},
        onError: (err) => console.error(`Agent task error for card ${id}:`, err),
      }, options?.assignmentPrompt);
    }
  }

  return getCardById(id);
}

export async function deleteCard(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const deleted = await store.transaction(async () => {
    // Remove card comments
    deleteCardCommentsByCardId(id);
    // Remove card tags
    deleteCardTagsByCardId(id);
    // Remove board cards
    deleteBoardCardsByCardId(id);
    // Remove card links
    deleteCardLinksForCard(id);
    // Preserve run history while removing foreign key references to this card.
    await clearAgentRunCardReferences(id);
    // Batch items require a card_id, so remove them before the card row.
    deleteBatchRunItemsForCard(id);
    return store.delete('cards', id);
  });

  if (deleted && audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'card',
      entityId: id,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return deleted ?? null;
}

export async function addCardTag(cardId: string, tagId: string) {
  const existing = findCardTag(cardId, tagId);
  if (existing) return existing;
  return store.insert('cardTags', { cardId, tagId });
}

export async function removeCardTag(cardId: string, tagId: string) {
  await store.transaction(async () => {
    deleteCardTagPair(cardId, tagId);
  });
  return true;
}

export async function addCardLink(sourceCardId: string, targetCardId: string) {
  // Check no duplicate link exists (in either direction)
  const existing = findBidirectionalCardLink(sourceCardId, targetCardId);
  if (existing) return existing;
  return store.insert('cardLinks', { sourceCardId, targetCardId });
}

export async function removeCardLink(linkId: string) {
  return (await store.delete('cardLinks', linkId)) ?? null;
}

// Card comments

export async function listCardComments(
  cardId: string,
  limit = 50,
  offset = 0,
) {
  const all = listCardCommentsByCardId(cardId) as unknown as CardComment[];
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const total = all.length;
  const entries = all.slice(offset, offset + limit).map((comment) => {
    let author: CardAssignee = null;
    const user = store.getById('users', comment.authorId) as User | null;
    if (user) {
      if (user.type === 'agent') {
        const agent = user.agentId ? (store.getById('agents', user.agentId) as AgentRecord | null) : null;
        author = {
          id: agent?.id ?? user.id,
          firstName: agent?.name ?? user.firstName,
          lastName: '',
          type: 'agent' as const,
          avatarIcon: agent?.avatarIcon ?? null,
          avatarBgColor: agent?.avatarBgColor ?? null,
          avatarLogoColor: agent?.avatarLogoColor ?? null,
        };
      } else {
        author = {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          type: 'user' as const,
        };
      }
    } else {
      const agent = store.getById('agents', comment.authorId) as AgentRecord | null;
      if (agent) {
        author = {
          id: agent.id,
          firstName: agent.name,
          lastName: '',
          type: 'agent' as const,
          avatarIcon: agent.avatarIcon ?? null,
          avatarBgColor: agent.avatarBgColor ?? null,
          avatarLogoColor: agent.avatarLogoColor ?? null,
        };
      }
    }
    return { ...comment, author };
  });
  return { entries, total };
}

export async function createCardComment(
  cardId: string,
  content: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
  attachments?: Array<{ type: string; fileName: string; mimeType: string; fileSize: number; storagePath: string }>,
) {
  const comment = await store.insert('cardComments', {
    cardId,
    authorId: audit?.userId,
    content,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  }) as unknown as CardComment & {
    attachments?: Array<{ type: string; fileName: string; mimeType: string; fileSize: number; storagePath: string }>;
  };

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'create',
      entityType: 'card_comment',
      entityId: comment.id,
      changes: { cardId, content },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return comment;
}

export async function updateCardComment(
  commentId: string,
  content: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const updated = await store.update('cardComments', commentId, { content, updatedAt: new Date().toISOString() });
  if (!updated) return null;

  if (audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'update',
      entityType: 'card_comment',
      entityId: commentId,
      changes: { content },
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return updated;
}

export async function deleteCardComment(
  commentId: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  const deleted = await store.delete('cardComments', commentId);

  if (deleted && audit) {
    await createAuditLog({
      userId: audit.userId,
      action: 'delete',
      entityType: 'card_comment',
      entityId: commentId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    });
  }

  return deleted ?? null;
}
