import type { Drawing, DrawingSummary, Collection } from "../types";

const DB_NAME = "excalidash-offline";
const DB_VERSION = 3;
const STORE_DRAWINGS = "drawings";
const STORE_SUMMARIES = "summaries";
const STORE_COLLECTIONS = "collections";
const STORE_PENDING_OPS = "pendingOps";
const STORE_ID_MAP = "idMap";

export type PendingOpType = "create" | "update" | "delete";
export type EntityType = "drawing" | "collection";

export interface PendingOp {
  id: string;
  drawingId: string;
  type: PendingOpType;
  payload: Partial<Drawing> | Record<string, unknown> | null;
  createdAt: number;
  attempts: number;
  entityType?: EntityType;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DRAWINGS)) {
        db.createObjectStore(STORE_DRAWINGS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SUMMARIES)) {
        db.createObjectStore(STORE_SUMMARIES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
        db.createObjectStore(STORE_COLLECTIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_PENDING_OPS)) {
        db.createObjectStore(STORE_PENDING_OPS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_ID_MAP)) {
        db.createObjectStore(STORE_ID_MAP, { keyPath: "localId" });
      }
    };
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

function txAll<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return tx(store, mode, fn);
}

export async function cacheDrawing(drawing: Drawing): Promise<void> {
  await tx(STORE_DRAWINGS, "readwrite", (s) => s.put(drawing));
}

export async function cacheDrawingSummary(summary: DrawingSummary): Promise<void> {
  await tx(STORE_SUMMARIES, "readwrite", (s) => s.put(summary));
}

export async function cacheDrawingSummaries(summaries: DrawingSummary[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_SUMMARIES, "readwrite");
    const s = t.objectStore(STORE_SUMMARIES);
    for (const summary of summaries) s.put(summary);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function cacheCollections(collections: Collection[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_COLLECTIONS, "readwrite");
    const s = t.objectStore(STORE_COLLECTIONS);
    for (const c of collections) s.put(c);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function cacheCollection(collection: Collection): Promise<void> {
  await tx(STORE_COLLECTIONS, "readwrite", (s) => s.put(collection));
}

export async function removeCachedCollection(id: string): Promise<void> {
  await tx(STORE_COLLECTIONS, "readwrite", (s) => s.delete(id));
}

export async function updateCachedCollection(id: string, patch: Partial<Collection>): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_COLLECTIONS, "readwrite");
    const s = t.objectStore(STORE_COLLECTIONS);
    const getReq = s.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as Collection | undefined;
      if (existing) {
        s.put({ ...existing, ...patch });
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getCachedDrawing(id: string): Promise<Drawing | undefined> {
  return tx(STORE_DRAWINGS, "readonly", (s) => s.get(id));
}

export async function getCachedDrawingSummaries(): Promise<DrawingSummary[]> {
  return txAll(STORE_SUMMARIES, "readonly", (s) => s.getAll());
}

export async function getCachedCollections(): Promise<Collection[]> {
  return txAll(STORE_COLLECTIONS, "readonly", (s) => s.getAll());
}

export async function removeCachedDrawing(id: string): Promise<void> {
  await tx(STORE_DRAWINGS, "readwrite", (s) => s.delete(id));
  await tx(STORE_SUMMARIES, "readwrite", (s) => s.delete(id));
}

export async function enqueuePendingOp(op: Omit<PendingOp, "id" | "createdAt" | "attempts">): Promise<PendingOp> {
  const fullOp: PendingOp = {
    ...op,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    attempts: 0,
  };
  await tx(STORE_PENDING_OPS, "readwrite", (s) => s.add(fullOp));
  return fullOp;
}

export async function getPendingOps(): Promise<PendingOp[]> {
  const ops = await txAll(STORE_PENDING_OPS, "readonly", (s) => s.getAll());
  return ops.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removePendingOp(id: string): Promise<void> {
  await tx(STORE_PENDING_OPS, "readwrite", (s) => s.delete(id));
}

export async function incrementOpAttempts(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_PENDING_OPS, "readwrite");
    const s = t.objectStore(STORE_PENDING_OPS);
    const getReq = s.get(id);
    getReq.onsuccess = () => {
      const op = getReq.result as PendingOp | undefined;
      if (op) {
        op.attempts++;
        s.put(op);
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function hasPendingOps(): Promise<boolean> {
  const count = await tx(STORE_PENDING_OPS, "readonly", (s) => s.count());
  return count > 0;
}

export async function clearAllPendingOps(): Promise<void> {
  await tx(STORE_PENDING_OPS, "readwrite", (s) => s.clear());
}

export async function updateCachedDrawingSummary(id: string, patch: Partial<DrawingSummary>): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_SUMMARIES, "readwrite");
    const s = t.objectStore(STORE_SUMMARIES);
    const getReq = s.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result as DrawingSummary | undefined;
      if (existing) {
        s.put({ ...existing, ...patch, updatedAt: Date.now() });
      } else {
        s.put({
          id,
          name: patch.name ?? "Untitled Drawing",
          collectionId: patch.collectionId ?? null,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          version: patch.version ?? 1,
          preview: patch.preview ?? null,
          ...patch,
        } as DrawingSummary);
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getCachedDrawingSummary(id: string): Promise<DrawingSummary | undefined> {
  return tx(STORE_SUMMARIES, "readonly", (s) => s.get(id));
}

export interface IdMapping {
  localId: string;
  serverId: string;
  createdAt: number;
}

export async function setIdMapping(localId: string, serverId: string): Promise<void> {
  const mapping: IdMapping = { localId, serverId, createdAt: Date.now() };
  await tx(STORE_ID_MAP, "readwrite", (s) => s.put(mapping));
}

export async function getIdMapping(localId: string): Promise<string | undefined> {
  const mapping = await tx<IdMapping | undefined>(STORE_ID_MAP, "readonly", (s) => s.get(localId));
  return mapping?.serverId;
}

export async function clearIdMappings(): Promise<void> {
  await tx(STORE_ID_MAP, "readwrite", (s) => s.clear());
}
