import { deleteCardTagsForTagId } from './boards-cards-repository.js';
import { store } from '../connection.js';
import type { StoreRecord } from '../store.js';

const TAGS = 'tags';
const CARD_TAGS = 'cardTags';

export function listTags(): StoreRecord[] {
  return store.getAll(TAGS);
}

export function listCardTags(): StoreRecord[] {
  return store.getAll(CARD_TAGS);
}

export function findTagByName(name: string): StoreRecord | null {
  for (const row of store.getAll(TAGS)) {
    if (row.name === name) return row;
  }
  return null;
}

export function insertTag(data: StoreRecord): StoreRecord {
  return store.insert(TAGS, data);
}

export function updateTag(id: string, data: StoreRecord): StoreRecord | null {
  return store.update(TAGS, id, data);
}

export function deleteTag(id: string): StoreRecord | null {
  return store.delete(TAGS, id);
}

/** Remove all card–tag rows for a tag (tag delete cascade). */
export function removeCardTagsForTag(tagId: string): void {
  deleteCardTagsForTagId(tagId);
}
