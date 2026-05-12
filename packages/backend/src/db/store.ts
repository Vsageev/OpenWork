export type StoreRecord = Record<string, unknown>;
export type DurableStoreRecord<T extends StoreRecord = StoreRecord> = T & PromiseLike<T>;
export type NativeQueryStore<TDatabase = unknown> = {
  nativeDb(): TDatabase;
};

export interface Store {
  init(): Promise<void>;
  getAll(collection: string): StoreRecord[];
  getById(collection: string, id: string): StoreRecord | null;
  count(collection: string): number;
  insert(collection: string, data: StoreRecord): DurableStoreRecord;
  insertMany(collection: string, items: StoreRecord[]): DurableStoreRecord[];
  update(collection: string, id: string, data: StoreRecord): DurableStoreRecord | null;
  delete(collection: string, id: string): DurableStoreRecord | null;
  transaction<T>(operation: () => Promise<T> | T): Promise<T>;
  reload(): Promise<void>;
  flush(): Promise<void>;
}
