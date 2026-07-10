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
      // Resolve a possibly-remapped drawing id: offline-created drawings get a
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
        if (op.type === "create") {
          const { id: serverId } = await api.createDrawing(
            op.payload?.name,
            op.payload?.collectionId,
          );
          const cached = await getCachedDrawing(op.drawingId);
          if (cached) {
            await api.updateDrawing(serverId, {
              elements: cached.elements,
              appState: cached.appState,
              files: cached.files ?? undefined,
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
          // Persist the local→server id mapping so future sync runs (and ops
          // still enqueued by an open editor referencing the local id) resolve
          // correctly, then drop the local-id cache entries to avoid duplicates.
          idMap.set(op.drawingId, serverId);
          await setIdMapping(op.drawingId, serverId);
          await removeCachedDrawing(op.drawingId);
          return true;
        }

        if (op.type === "update") {
          const cached = await getCachedDrawing(op.drawingId);
          const payload = op.payload ?? {};
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
      } catch (err) {
        console.warn("[offline] Op failed:", op.type, op.drawingId, err);
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

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    refreshPendingCount();
    // Drain pending ops left over from a previous offline session on startup
    // (the "online" event won't fire again if the device was already online).
    void triggerSync();

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
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
