import { store } from '../db/index.js';
import { createAuditLog } from './audit-log.js';
import { getAgent } from './agents.js';
import { executeCardTask } from './agent-chat.js';

export interface CardListQuery {
  collectionId?: string;
  assigneeId?: string;
  search?: string;
  completed?: boolean;
  priority?: 'high' | 'medium' | 'low';
  dueDateBefore?: string;
  dueDateAfter?: string;
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

export async function listCards(query: CardListQuery) {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  let all = store.getAll('cards') as any[];

  if (query.collectionId) {
    all = all.filter((c: any) => c.collectionId === query.collectionId);
  }

  if (query.assigneeId) {
    all = all.filter((c: any) => c.assigneeId === query.assigneeId);
  }

  if (query.search) {
    const term = query.search.toLowerCase();
    all = all.filter(
      (c: any) =>
        c.name?.toLowerCase().includes(term) ||
        c.description?.toLowerCase().includes(term),
    );
  }

  if (query.completed !== undefined) {
    all = all.filter((c: any) => (c.customFields?.completed === true) === query.completed);
  }

  if (query.priority) {
    all = all.filter((c: any) => c.customFields?.priority === query.priority);
  }

  if (query.dueDateBefore) {
    const before = new Date(query.dueDateBefore).getTime();
    all = all.filter((c: any) => {
      const d = c.customFields?.dueDate as string | undefined;
      return d ? new Date(d).getTime() < before : false;
    });
  }

  if (query.dueDateAfter) {
    const after = new Date(query.dueDateAfter).getTime();
    all = all.filter((c: any) => {
      const d = c.customFields?.dueDate as string | undefined;
      return d ? new Date(d).getTime() > after : false;
    });
  }

  if (query.tagId) {
    const taggedCardIds = new Set(
      (store.find('cardTags', (r: any) => r.tagId === query.tagId) as any[]).map((ct: any) => ct.cardId),
    );
    all = all.filter((c: any) => taggedCardIds.has(c.id));
  }

  const total = all.length;

  if (limit === 0) {
    return { entries: [], total };
  }

  all.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const entries = all.slice(offset, offset + limit);

  // Hydrate assignee and tags for list entries
  const hydrated = entries.map((card: any) => {
    let assignee = null;
    if (card.assigneeId) {
      const user = store.getById('users', card.assigneeId) as any;
      if (user) {
        assignee = { id: user.id, firstName: user.firstName, lastName: user.lastName, type: 'user' as const };
      } else {
        const agent = store.getById('agents', card.assigneeId) as any;
        if (agent) {
          assignee = {
            id: agent.id, firstName: agent.name, lastName: '', type: 'agent' as const,
            avatarIcon: agent.avatarIcon ?? null, avatarBgColor: agent.avatarBgColor ?? null, avatarLogoColor: agent.avatarLogoColor ?? null,
          };
        }
      }
    }

    const cardTags = store.find('cardTags', (r: any) => r.cardId === card.id) as any[];
    const tags = cardTags
      .map((ct: any) => store.getById('tags', ct.tagId))
      .filter(Boolean)
      .map((t: any) => ({ id: t.id, name: t.name, color: t.color }));

    return { ...card, assignee, tags };
  });

  return { entries: hydrated, total };
}

export async function getCardById(id: string) {
  const card = store.getById('cards', id);
  if (!card) return null;

  // Load tags
  const cardTags = store.find('cardTags', (r: any) => r.cardId === id) as any[];
  const tagIds = cardTags.map((ct: any) => ct.tagId);
  const tags = tagIds
    .map((tid: string) => store.getById('tags', tid))
    .filter(Boolean);

  // Load assignee
  let assignee = null;
  if ((card as any).assigneeId) {
    const user = store.getById('users', (card as any).assigneeId) as any;
    if (user) {
      assignee = { id: user.id, firstName: user.firstName, lastName: user.lastName, type: 'user' as const };
    } else {
      const agentRec = store.getById('agents', (card as any).assigneeId) as any;
      if (agentRec) {
        assignee = {
          id: agentRec.id, firstName: agentRec.name, lastName: '', type: 'agent' as const,
          avatarIcon: agentRec.avatarIcon ?? null, avatarBgColor: agentRec.avatarBgColor ?? null, avatarLogoColor: agentRec.avatarLogoColor ?? null,
        };
      }
    }
  }

  // Load linked cards
  const outgoing = store.find('cardLinks', (r: any) => r.sourceCardId === id) as any[];
  const incoming = store.find('cardLinks', (r: any) => r.targetCardId === id) as any[];

  const linkedCards: any[] = [];
  for (const link of outgoing) {
    const target = store.getById('cards', link.targetCardId) as any;
    if (target) {
      linkedCards.push({ linkId: link.id, id: target.id, name: target.name, collectionId: target.collectionId });
    }
  }
  for (const link of incoming) {
    const source = store.getById('cards', link.sourceCardId) as any;
    if (source) {
      // Avoid duplicates if link exists both ways
      if (!linkedCards.some((lc) => lc.id === source.id)) {
        linkedCards.push({ linkId: link.id, id: source.id, name: source.name, collectionId: source.collectionId });
      }
    }
  }

  // Load board placements
  const boardCards = store.find('boardCards', (r: any) => r.cardId === id) as any[];
  const boards: any[] = [];
  for (const bc of boardCards) {
    const board = store.getById('boards', bc.boardId) as any;
    if (!board) continue;
    const column = store.getById('boardColumns', bc.columnId) as any;
    boards.push({
      boardId: board.id,
      boardName: board.name,
      columnId: bc.columnId,
      columnName: column?.name ?? null,
      columnColor: column?.color ?? null,
    });
  }

  return { ...(card as any), tags, assignee, linkedCards, boards };
}

export async function createCard(
  data: CreateCardData,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  // Auto-calculate position if not provided
  let position = data.position;
  if (position === undefined) {
    const existing = store.find('cards', (r: any) => r.collectionId === data.collectionId) as any[];
    position = existing.length;
  }

  const card = store.insert('cards', {
    collectionId: data.collectionId,
    name: data.name,
    description: data.description ?? null,
    customFields: data.customFields ?? {},
    assigneeId: data.assigneeId ?? null,
    position,
    createdById: audit?.userId,
  }) as any;

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
) {
  // Capture current assignee before updating so we can detect changes
  const current = store.getById('cards', id) as any;
  if (!current) return null;
  const prevAssigneeId = current.assigneeId as string | null;

  const setData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      setData[key] = value;
    }
  }
  setData.updatedAt = new Date().toISOString();

  const updated = store.update('cards', id, setData);
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
      const refreshed = updated as any;
      executeCardTask(agent.id, {
        id,
        name: refreshed.name,
        description: refreshed.description,
        collectionId: refreshed.collectionId,
      }, {
        onDone: () => {},
        onError: (err) => console.error(`Agent task error for card ${id}:`, err),
      });
    }
  }

  return getCardById(id);
}

export async function deleteCard(
  id: string,
  audit?: { userId: string; ipAddress?: string; userAgent?: string },
) {
  // Remove card comments
  store.deleteWhere('cardComments', (r: any) => r.cardId === id);
  // Remove card tags
  store.deleteWhere('cardTags', (r: any) => r.cardId === id);
  // Remove board cards
  store.deleteWhere('boardCards', (r: any) => r.cardId === id);
  // Remove card links
  store.deleteWhere('cardLinks', (r: any) => r.sourceCardId === id || r.targetCardId === id);

  const deleted = store.delete('cards', id);

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
  const existing = store.findOne('cardTags', (r: any) => r.cardId === cardId && r.tagId === tagId);
  if (existing) return existing;
  return store.insert('cardTags', { cardId, tagId });
}

export async function removeCardTag(cardId: string, tagId: string) {
  store.deleteWhere('cardTags', (r: any) => r.cardId === cardId && r.tagId === tagId);
  return true;
}

export async function addCardLink(sourceCardId: string, targetCardId: string) {
  // Check no duplicate link exists (in either direction)
  const existing = store.findOne('cardLinks', (r: any) =>
    (r.sourceCardId === sourceCardId && r.targetCardId === targetCardId) ||
    (r.sourceCardId === targetCardId && r.targetCardId === sourceCardId),
  );
  if (existing) return existing;
  return store.insert('cardLinks', { sourceCardId, targetCardId });
}

export async function removeCardLink(linkId: string) {
  return store.delete('cardLinks', linkId) ?? null;
}

// Card comments

export async function listCardComments(
  cardId: string,
  limit = 50,
  offset = 0,
) {
  let all = store.find('cardComments', (r: any) => r.cardId === cardId) as any[];
  all.sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
  const total = all.length;
  const entries = all.slice(offset, offset + limit).map((comment: any) => {
    let author = null;
    const user = store.getById('users', comment.authorId) as any;
    if (user) {
      if (user.type === 'agent') {
        const agent = user.agentId ? (store.getById('agents', user.agentId) as any) : null;
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
      const agent = store.getById('agents', comment.authorId) as any;
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
) {
  const comment = store.insert('cardComments', {
    cardId,
    authorId: audit?.userId,
    content,
  }) as any;

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
  const updated = store.update('cardComments', commentId, { content, updatedAt: new Date().toISOString() });
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
  const deleted = store.delete('cardComments', commentId);

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
