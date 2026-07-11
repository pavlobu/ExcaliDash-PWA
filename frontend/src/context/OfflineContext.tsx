import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import {
  getPendingOps,
  removePendingOp,
  incrementOpAttempts,
  hasPendingOps,
  getCachedDrawing,
  cacheDrawingSummary,
  removeCachedDrawing,
  getIdMapping,
  setIdMapping,
  clearIdMappings,
  cacheCollection,
  removeCachedCollection,
} from "../db/offline-db";
import * as api from "../api";
import type { PendingOp } from "../db/offline-db";

interface OfflineContextType {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  triggerSync: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextType | undefined>(undefined);

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
  const [pendingCount, setPendingCount] = useState(0);
  const syncingRef = useRef(false);

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

    try {
      const ops = await getPendingOps();
      const idMap = new Map<string, string>();
      for (const op of ops) {
        const success = await processOp(op, idMap);
        if (success) {
          await removePendingOp(op.id);
          processedAny = true;
        } else {
          break;
        }
      }
    } catch (err) {
      console.error("[offline] Sync error:", err);
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

  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      setTimeout(() => triggerSync(), 500);
    };
    const goOffline = () => {
      setIsOnline(false);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (typeof navigator === "undefined" || navigator.onLine) {
          void triggerSync();
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

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [triggerSync, refreshPendingCount]);

  return (
    <OfflineContext.Provider value={{ isOnline, isSyncing, pendingCount, triggerSync }}>
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
