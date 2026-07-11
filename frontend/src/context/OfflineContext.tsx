import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  getPendingOps,
  removePendingOp,
  incrementOpAttempts,
  hasPendingOps,
  getCachedDrawing,
  cacheDrawing,
  cacheDrawingSummary,
  removeCachedDrawing,
  getIdMapping,
  setIdMapping,
  clearIdMappings,
  cacheCollection,
  removeCachedCollection,
  getCachedDrawingSummaries,
} from "../db/offline-db";
import * as api from "../api";
import type { PendingOp } from "../db/offline-db";

interface OfflineContextType {
  isOnline: boolean;
  isSyncing: boolean;
  isPrefetching: boolean;
  pendingCount: number;
  triggerSync: () => Promise<void>;
  triggerPrefetch: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextType | undefined>(undefined);

// Minimum interval between background prefetches (15 minutes).
const PREFETCH_INTERVAL_MS = 15 * 60 * 1000;

async function resolveId(localId: string | null | undefined, idMap: Map<string, string>): Promise<string | null | undefined> {
  if (!localId) return localId;
  if (idMap.has(localId)) return idMap.get(localId);
  const persisted = await getIdMapping(localId);
  if (persisted) {
    idMap.set(localId, persisted);
    return persisted;
  }
  return localId;
}

async function processDrawingOp(
  op: PendingOp,
  targetId: string,
  idMap: Map<string, string>,
): Promise<boolean> {
  if (op.type === "create") {
    // Remap collectionId: if the drawing was placed in an offline-created
    // collection (local UUID), resolve it to the server-assigned id.
    const collectionId = await resolveId(
      op.payload?.collectionId as string | null | undefined,
      idMap,
    );
    const { id: serverId } = await api.createDrawing(
      op.payload?.name as string | undefined,
      collectionId,
    );
    const cached = await getCachedDrawing(op.drawingId);
    if (cached) {
      await api.updateDrawing(serverId, {
        elements: cached.elements,
        appState: cached.appState,
        files: cached.files ?? undefined,
        ...(op.payload?.name ? { name: op.payload.name as string } : {}),
      });
      await cacheDrawingSummary({
        id: serverId,
        name: cached.name,
        collectionId: cached.collectionId,
        updatedAt: Date.now(),
        createdAt: cached.createdAt ?? Date.now(),
        version: 1,
        preview: cached.preview ?? null,
      });
    }
    idMap.set(op.drawingId, serverId);
    await setIdMapping(op.drawingId, serverId);
    await removeCachedDrawing(op.drawingId);
    return true;
  }

  if (op.type === "update") {
    const cached = await getCachedDrawing(op.drawingId);
    const payload = { ...(op.payload ?? {}) };
    // Remap collectionId for move operations targeting an offline-created
    // collection.
    if (payload.collectionId) {
      payload.collectionId = await resolveId(payload.collectionId as string, idMap);
    }
    await api.updateDrawing(targetId, {
      ...payload,
      version: cached?.version,
    });
    return true;
  }

  if (op.type === "delete") {
    await api.deleteDrawing(targetId);
    await removeCachedDrawing(op.drawingId);
    return true;
  }

  return true;
}

async function processCollectionOp(
  op: PendingOp,
  targetId: string,
  idMap: Map<string, string>,
): Promise<boolean> {
  if (op.type === "create") {
    const serverCollection = await api.createCollection(
      op.payload?.name as string,
    );
    idMap.set(op.drawingId, serverCollection.id);
    await setIdMapping(op.drawingId, serverCollection.id);
    await cacheCollection(serverCollection);
    await removeCachedCollection(op.drawingId);
    return true;
  }

  if (op.type === "update") {
    const name = op.payload?.name as string | undefined;
    if (name !== undefined) {
      await api.updateCollection(targetId, name);
    }
    return true;
  }

  if (op.type === "delete") {
    await api.deleteCollection(targetId);
    await removeCachedCollection(op.drawingId);
    return true;
  }

  return true;
}

export const OfflineProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPrefetching, setIsPrefetching] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const syncingRef = useRef(false);
  const prefetchingRef = useRef(false);
  const lastPrefetchAtRef = useRef(0);

  const refreshPendingCount = useCallback(async () => {
    try {
      const has = await hasPendingOps();
      setPendingCount(has ? (await getPendingOps()).length : 0);
    } catch {
      setPendingCount(0);
    }
  }, []);

  const processOp = useCallback(
    async (op: PendingOp, idMap: Map<string, string>): Promise<boolean> => {
      const entityType = op.entityType ?? "drawing";

      // Resolve a possibly-remapped id: offline-created entities get a
      // server-assigned id on first sync; later update/delete ops (and ops from
      // a previous sync run) still reference the local id and must be remapped.
      let resolvedId = idMap.get(op.drawingId);
      if (!resolvedId) {
        const persisted = await getIdMapping(op.drawingId);
        if (persisted) {
          idMap.set(op.drawingId, persisted);
          resolvedId = persisted;
        }
      }
      const targetId = resolvedId ?? op.drawingId;

      try {
        if (entityType === "collection") {
          return await processCollectionOp(op, targetId, idMap);
        }
        return await processDrawingOp(op, targetId, idMap);
      } catch (err) {
        console.warn("[offline] Op failed:", op.type, op.entityType, op.drawingId, err);
        await incrementOpAttempts(op.id);
        return false;
      }
    },
    [],
  );

  const triggerSync = useCallback(async () => {
    if (syncingRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;

    syncingRef.current = true;
    setIsSyncing(true);
    let processedAny = false;
    let totalProcessed = 0;

    try {
      const ops = await getPendingOps();
      const idMap = new Map<string, string>();
      for (const op of ops) {
        const success = await processOp(op, idMap);
        if (success) {
          await removePendingOp(op.id);
          processedAny = true;
          totalProcessed++;
        } else {
          break;
        }
      }
      if (processedAny) {
        toast.success(`${totalProcessed} change${totalProcessed !== 1 ? "s" : ""} synced to server`);
      }
    } catch (err) {
      console.error("[offline] Sync error:", err);
      toast.error("Failed to sync some changes. Will retry automatically.");
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
      await refreshPendingCount();
      try {
        const remaining = await hasPendingOps();
        if (!remaining) await clearIdMappings();
      } catch {
        // IndexedDB unavailable
      }
      if (processedAny) {
        window.dispatchEvent(new CustomEvent("excalidash:offline-sync"));
      }
    }
  }, [processOp, refreshPendingCount]);

  // Background prefetch: fetch full drawing data for ALL drawings and cache
  // them to IndexedDB so they can be opened offline even if the user never
  // opened them before. Runs on app launch, after online sync, and every
  // 15 minutes when online.
  const triggerPrefetch = useCallback(async () => {
    if (prefetchingRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;

    // Throttle: don't prefetch more often than every 15 minutes.
    const now = Date.now();
    if (now - lastPrefetchAtRef.current < PREFETCH_INTERVAL_MS) return;

    prefetchingRef.current = true;
    setIsPrefetching(true);
    let fetched = 0;

    try {
      // Fetch all drawing summaries (page through all results).
      const allSummaries: any[] = [];
      let offset = 0;
      const pageSize = 100;
      while (true) {
        const res = await api.getDrawings(undefined, undefined, {
          limit: pageSize,
          offset,
        });
        allSummaries.push(...res.drawings);
        if (res.drawings.length < pageSize) break;
        offset += pageSize;
      }

      // Check which drawings are already cached with the latest version.
      const cachedSummaries = await getCachedDrawingSummaries();
      const cachedVersions = new Map<string, number>();
      for (const s of cachedSummaries) {
        if (typeof s.version === "number") cachedVersions.set(s.id, s.version);
      }

      // Fetch full data only for drawings that are missing from cache or
      // have a newer server version.
      const toFetch = allSummaries.filter((s) => {
        const cachedVer = cachedVersions.get(s.id);
        return cachedVer === undefined || cachedVer !== s.version;
      });

      // Fetch in small batches to avoid overwhelming the server.
      const BATCH = 5;
      for (let i = 0; i < toFetch.length; i += BATCH) {
        const batch = toFetch.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map((s) => api.getDrawing(s.id)),
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            await cacheDrawing(result.value);
            await cacheDrawingSummary({
              id: result.value.id,
              name: result.value.name,
              collectionId: result.value.collectionId,
              updatedAt: result.value.updatedAt,
              createdAt: result.value.createdAt,
              version: result.value.version,
              preview: result.value.preview ?? null,
            });
            fetched++;
          }
        }
      }

      lastPrefetchAtRef.current = Date.now();

      if (fetched > 0) {
        toast.success(`${fetched} drawing${fetched !== 1 ? "s" : ""} synced for offline use`);
        window.dispatchEvent(new CustomEvent("excalidash:offline-sync"));
      }
    } catch (err) {
      console.error("[offline] Prefetch error:", err);
    } finally {
      prefetchingRef.current = false;
      setIsPrefetching(false);
    }
  }, []);

  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      setTimeout(async () => {
        // Push offline changes to server first, then prefetch full data.
        await triggerSync();
        setTimeout(() => triggerPrefetch(), 1000);
      }, 500);
    };
    const goOffline = () => {
      setIsOnline(false);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (typeof navigator === "undefined" || navigator.onLine) {
          void triggerSync();
          void triggerPrefetch();
        }
      }
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);

    refreshPendingCount();
    // Drain pending ops left over from a previous offline session on startup
    // (the "online" event won't fire again if the device was already online).
    void triggerSync();
    // Prefetch all drawings for offline use on app launch.
    setTimeout(() => void triggerPrefetch(), 3000);

    // Periodic prefetch every 15 minutes.
    const prefetchInterval = setInterval(() => {
      if (typeof navigator === "undefined" || navigator.onLine) {
        void triggerPrefetch();
      }
    }, PREFETCH_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearInterval(prefetchInterval);
    };
  }, [triggerSync, triggerPrefetch, refreshPendingCount]);

  return (
    <OfflineContext.Provider value={{ isOnline, isSyncing, isPrefetching, pendingCount, triggerSync, triggerPrefetch }}>
      {children}
    </OfflineContext.Provider>
  );
};

export const useOffline = () => {
  const ctx = useContext(OfflineContext);
  if (ctx === undefined) {
    throw new Error("useOffline must be used within an OfflineProvider");
  }
  return ctx;
};
