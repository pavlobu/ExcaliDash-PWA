import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { exportToSvg } from "@excalidraw/excalidraw";
import debounce from "lodash/debounce";
import { toast } from "sonner";
import * as api from "../../api";
import { compressExcalidrawFiles } from "../../utils/imageCompression";
import { reconcileElements } from "../../utils/sync";
import {
  getFilesDelta,
  getPersistedAppState,
  hasRenderableElements,
} from "./shared";
import {
  cacheDrawing,
  enqueuePendingOp,
  getCachedDrawing,
  updateCachedDrawing,
  updateCachedDrawingSummary,
} from "../../db/offline-db";

class DrawingSaveConflictError extends Error {
  constructor(message = "Drawing version conflict") {
    super(message);
    this.name = "DrawingSaveConflictError";
  }
}

type PersistenceRefs = {
  currentDrawingVersion: MutableRefObject<number | null>;
  debouncedSave: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => void)
    | null
  >;
  drawingName: MutableRefObject<string>;
  excalidrawAPI: MutableRefObject<any>;
  isSyncing: MutableRefObject<boolean>;
  isUnmounting: MutableRefObject<boolean>;
  lastLocalChangeAt: MutableRefObject<number>;
  lastPersistedElements: MutableRefObject<readonly any[]>;
  lastPersistedFiles: MutableRefObject<Record<string, any>>;
  lastSyncedFiles: MutableRefObject<Record<string, any>>;
  latestAppState: MutableRefObject<any>;
  latestElements: MutableRefObject<readonly any[]>;
  latestFiles: MutableRefObject<any>;
  saveQueue: MutableRefObject<Promise<void>>;
  suspiciousBlankLoad: MutableRefObject<boolean>;
};

type UseEditorPersistenceParams = {
  refs: PersistenceRefs;
  user: unknown;
  normalizeImageElementStatus: (
    elements?: readonly any[],
    files?: Record<string, any> | null,
  ) => readonly any[];
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    snapshot: readonly any[];
    prevented: boolean;
    staleEmptySnapshot: boolean;
    staleNonRenderableSnapshot: boolean;
  };
};

export const useEditorPersistence = ({
  refs,
  user,
  normalizeImageElementStatus,
  resolveSafeSnapshot,
}: UseEditorPersistenceParams) => {
  const saveDataRef = useRef<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => Promise<void>)
    | null
  >(null);
  const savePreviewRef = useRef<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files: any,
      ) => Promise<void>)
    | null
  >(null);
  const saveLibraryRef = useRef<((items: any[]) => Promise<void>) | null>(null);

  saveDataRef.current = async (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files?: Record<string, any>,
  ) => {
    if (!drawingId) return;
    let normalizedElementsForSave: any[] = [];
    let persistableAppState: any = {};
    let persistableFiles: Record<string, any> = {};
    let filesChangedSincePersist = false;
    try {
      persistableAppState = getPersistedAppState(appState);
      const candidateElements = Array.isArray(elements) ? elements : [];
      const {
        snapshot: safeElements,
        prevented,
        staleEmptySnapshot,
        staleNonRenderableSnapshot,
      } = resolveSafeSnapshot(candidateElements);
      const persistableElements = Array.from(safeElements);
      if (
        refs.suspiciousBlankLoad.current &&
        !hasRenderableElements(persistableElements)
      ) {
        console.warn(
          "[Editor] Blocking non-renderable save due to suspicious blank load",
          { drawingId, elementCount: persistableElements.length },
        );
        return;
      }
      if (staleEmptySnapshot || staleNonRenderableSnapshot) {
        console.warn("[Editor] Skipping stale snapshot save", {
          drawingId,
          candidateElementCount: candidateElements.length,
          fallbackElementCount: persistableElements.length,
          prevented,
          staleEmptySnapshot,
          staleNonRenderableSnapshot,
        });
        return;
      }
      let persistableFilesInner = files ?? refs.latestFiles.current ?? {};
      const compressedFilesResult =
        await compressExcalidrawFiles(persistableFilesInner);
      if (compressedFilesResult.changed) {
        persistableFilesInner = compressedFilesResult.files;
        if (
          refs.excalidrawAPI.current &&
          typeof refs.excalidrawAPI.current.addFiles === "function"
        ) {
          refs.isSyncing.current = true;
          try {
            refs.excalidrawAPI.current.addFiles(
              Object.values(persistableFilesInner),
            );
          } finally {
            refs.isSyncing.current = false;
          }
        }
        refs.latestFiles.current = persistableFilesInner;
        refs.lastSyncedFiles.current = persistableFilesInner;
      }
      persistableFiles = persistableFilesInner;
      filesChangedSincePersist =
        Object.keys(
          getFilesDelta(
            refs.lastPersistedFiles.current || {},
            persistableFilesInner || {},
          ),
        ).length > 0;
      normalizedElementsForSave = Array.from(
        normalizeImageElementStatus(persistableElements, persistableFilesInner),
      );
      const currentName = refs.drawingName.current || "Untitled Drawing";
      const currentVersion = refs.currentDrawingVersion.current ?? 1;

      // OPTIMISTIC LOCAL CACHE — write the scene to IndexedDB BEFORE any
      // network call. This is the fix for the iOS PWA data-loss scenario:
      // navigator.onLine can report true with no connectivity, so the
      // network save hangs up to the axios timeout (15s), blocking the
      // serialized saveQueue. If the app is killed during that window,
      // every save queued behind the hang is discarded — only saves that
      // completed before the hang survive, so the user sees "only the first
      // few sentences." Caching first guarantees the local store always
      // has the latest scene regardless of network fate. The success path
      // below re-caches with the server-assigned version; the OfflineContext
      // sync layer reconciles pending ops on reconnect.
      try {
        const existing = await getCachedDrawing(drawingId).catch(() => undefined);
        if (existing) {
          await updateCachedDrawing(drawingId, {
            name: currentName,
            elements: normalizedElementsForSave,
            appState: persistableAppState,
            ...(filesChangedSincePersist ? { files: persistableFiles } : {}),
            ...(typeof currentVersion === "number" ? { version: currentVersion } : {}),
          });
        } else {
          await cacheDrawing({
            id: drawingId,
            name: currentName,
            collectionId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: currentVersion,
            elements: normalizedElementsForSave,
            appState: persistableAppState,
            files: persistableFiles || null,
            preview: null,
          });
        }
        await updateCachedDrawingSummary(drawingId, {
          name: currentName,
          updatedAt: Date.now(),
          ...(typeof currentVersion === "number" ? { version: currentVersion } : {}),
        });
        // Update the baseline so a later transient empty snapshot can't
        // overwrite the scene we just protected, and so subsequent saves
        // can diff against it.
        refs.lastPersistedElements.current = normalizedElementsForSave;
        if (filesChangedSincePersist) {
          refs.lastPersistedFiles.current = persistableFiles;
        }
      } catch (cacheErr) {
        console.error("[Editor] Optimistic local cache failed", cacheErr);
        // Proceed to network anyway — best-effort.
      }

      // If definitively offline, skip the network entirely (avoids the
      // 15s axios timeout blocking the queue) and enqueue a pending op
      // for the OfflineContext to push on reconnect.
      const isOffline =
        typeof navigator !== "undefined" && !navigator.onLine;
      if (isOffline) {
        try {
          await enqueuePendingOp({
            drawingId,
            type: "update",
            payload: {
              name: currentName,
              elements: normalizedElementsForSave,
              appState: persistableAppState,
              ...(filesChangedSincePersist ? { files: persistableFiles } : {}),
            },
          });
        } catch {
          // Best-effort — the cache already has the data; op retries next save.
        }
        return;
      }

      const persistScene = async (attempt: number): Promise<void> => {
        try {
          const updated = await api.updateDrawing(drawingId, {
            elements: normalizedElementsForSave,
            appState: persistableAppState,
            // Include the current name so scene saves also persist any
            // pending rename. This is a belt-and-suspenders approach:
            // commitRename already sends the rename separately, but if
            // that request is lost or races, the scene save ensures the
            // name reaches the server.
            name: refs.drawingName.current || undefined,
            ...(filesChangedSincePersist ? { files: persistableFiles } : {}),
            version: refs.currentDrawingVersion.current ?? undefined,
          });
          if (typeof updated.version === "number") {
            refs.currentDrawingVersion.current = updated.version;
          }
          refs.lastPersistedElements.current = normalizedElementsForSave;
          if (filesChangedSincePersist) {
            refs.lastPersistedFiles.current = persistableFiles;
          }
        } catch (err) {
          if (api.isAxiosError(err) && err.response?.status === 409) {
            const reportedVersion = Number(err.response?.data?.currentVersion);
            const hasReportedVersion =
              Number.isInteger(reportedVersion) && reportedVersion > 0;
            if (hasReportedVersion) {
              refs.currentDrawingVersion.current = reportedVersion;
            }
            if (attempt === 0 && hasReportedVersion) {
              // Re-fetch the server's latest scene and merge with local
              // edits before retrying. Without this, the retry would send
              // the same stale-base payload (just with a bumped version),
              // overwriting changes from another device.
              try {
                const serverDrawing = await api.getDrawing(drawingId);
                const serverElements = serverDrawing.elements || [];
                const serverFiles = serverDrawing.files || {};
                // Merge the current editor scene (which may include edits
                // made after this save was enqueued) with the server's
                // latest elements. reconcileElements picks the newer
                // version per element, preserving both devices' changes.
                const currentSceneElements =
                  refs.excalidrawAPI.current
                    ? refs.excalidrawAPI.current.getSceneElementsIncludingDeleted()
                    : normalizedElementsForSave;
                const mergedElements = reconcileElements(
                  currentSceneElements,
                  serverElements,
                );
                normalizedElementsForSave = Array.from(
                  normalizeImageElementStatus(
                    mergedElements,
                    persistableFilesInner,
                  ),
                );
                // Merge files: local takes precedence for newly-added
                // images, but server files are included so the other
                // device's image additions are preserved.
                const mergedFiles = {
                  ...serverFiles,
                  ...persistableFiles,
                };
                if (Object.keys(mergedFiles).length > 0) {
                  persistableFiles = mergedFiles;
                  filesChangedSincePersist = true;
                }
                refs.currentDrawingVersion.current =
                  typeof serverDrawing.version === "number"
                    ? serverDrawing.version
                    : reportedVersion;
                // Update the editor scene so the user sees the merged
                // result and the next autosave sends the correct base.
                if (refs.excalidrawAPI.current) {
                  refs.isSyncing.current = true;
                  try {
                    if (
                      Object.keys(serverFiles).length > 0 &&
                      typeof refs.excalidrawAPI.current.addFiles ===
                        "function"
                    ) {
                      refs.excalidrawAPI.current.addFiles(
                        Object.values(serverFiles),
                      );
                    }
                    refs.excalidrawAPI.current.updateScene({
                      elements: normalizedElementsForSave,
                      captureUpdate: "NEVER" as const,
                    });
                    refs.latestElements.current = normalizedElementsForSave;
                    refs.lastPersistedElements.current =
                      normalizedElementsForSave;
                    if (filesChangedSincePersist) {
                      refs.latestFiles.current = persistableFiles;
                      refs.lastSyncedFiles.current = persistableFiles;
                      refs.lastPersistedFiles.current = persistableFiles;
                    }
                  } finally {
                    refs.isSyncing.current = false;
                  }
                }
                toast.info(
                  "Merged your changes with updates from another device.",
                );
                await persistScene(1);
                return;
              } catch (mergeErr) {
                console.error(
                  "Failed to merge drawing conflict:",
                  mergeErr,
                );
              }
            }
            throw new DrawingSaveConflictError();
          }
          throw err;
        }
      };
      await persistScene(0);
      // Keep the local IndexedDB cache in sync with the scene we just
      // persisted to the server. Without this, the next cache-first open
      // (useEditorSceneLoader) shows the stale pre-edit version until the
      // background refresh catches up — causing a "changes gone on reopen,
      // appear on second reopen" flaky state. The offline fallback path
      // below already caches on failure; this mirrors it for the success
      // path.
      const savedVersion = refs.currentDrawingVersion.current;
      updateCachedDrawing(drawingId, {
        elements: normalizedElementsForSave,
        appState: persistableAppState,
        ...(filesChangedSincePersist ? { files: persistableFiles } : {}),
        ...(typeof savedVersion === "number" ? { version: savedVersion } : {}),
      }).catch(() => {});
      updateCachedDrawingSummary(drawingId, {
        name: refs.drawingName.current || "Untitled Drawing",
        updatedAt: Date.now(),
        ...(typeof savedVersion === "number" ? { version: savedVersion } : {}),
      }).catch(() => {});
    } catch (err) {
      if (err instanceof DrawingSaveConflictError) {
        toast.error("Drawing changed in another tab. Refresh to load latest.");
        throw err;
      }

      const isNetworkError = api.isNetworkError(err);

      if (isNetworkError && drawingId) {
        // The optimistic cache already wrote the scene to IndexedDB before
        // the network attempt. This handles the false-positive online case
        // (navigator.onLine was true, but the request failed/timed out):
        // just enqueue a pending op so the OfflineContext syncs on
        // reconnect. No need to re-cache — it was already done.
        try {
          const currentName = refs.drawingName.current || "Untitled Drawing";
          await enqueuePendingOp({
            drawingId,
            type: "update",
            payload: {
              name: currentName,
              elements: normalizedElementsForSave,
              appState: persistableAppState,
              ...(filesChangedSincePersist ? { files: persistableFiles } : {}),
            },
          });
          toast.info("Offline: changes saved locally. Will sync when reconnected.");
          return;
        } catch (cacheErr) {
          console.error("Failed to enqueue offline op:", cacheErr);
        }
      }

      console.error("Failed to save drawing", err);
      toast.error("Failed to save changes");
      throw err;
    }
  };

  const enqueueSceneSave = useCallback(
    (
      drawingId: string,
      elements: readonly any[],
      appState: any,
      files?: Record<string, any>,
      options?: { suppressErrors?: boolean },
    ) => {
      const suppressErrors = options?.suppressErrors ?? true;
      refs.saveQueue.current = refs.saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (!saveDataRef.current) return;
          if (suppressErrors) {
            try {
              await saveDataRef.current(drawingId, elements, appState, files);
            } catch {
              // Best-effort autosave errors are surfaced by explicit saves.
            }
            return;
          }
          await saveDataRef.current(drawingId, elements, appState, files);
        });
      return refs.saveQueue.current;
    },
    [refs],
  );

  savePreviewRef.current = async (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files: any,
  ) => {
    if (!drawingId) return;
    try {
      const snapshotFromArgs = Array.isArray(elements) ? elements : [];
      const snapshotFromRef = refs.latestElements.current ?? [];
      const candidateSnapshot =
        hasRenderableElements(snapshotFromArgs) ||
        !hasRenderableElements(snapshotFromRef)
          ? snapshotFromArgs
          : snapshotFromRef;
      const {
        snapshot: currentSnapshot,
        prevented: preventedPreviewOverwrite,
      } = resolveSafeSnapshot(candidateSnapshot);
      const currentFiles = refs.latestFiles.current ?? files;
      const normalizedSnapshot = normalizeImageElementStatus(
        currentSnapshot,
        currentFiles,
      );
      if (
        refs.suspiciousBlankLoad.current &&
        !hasRenderableElements(currentSnapshot)
      ) {
        return;
      }
      if (preventedPreviewOverwrite) {
        console.warn("[Editor] Prevented stale snapshot preview overwrite", {
          drawingId,
          fallbackElementCount: currentSnapshot.length,
        });
      }
      const svg = await exportToSvg({
        elements: normalizedSnapshot,
        appState: {
          ...appState,
          exportBackground: true,
          viewBackgroundColor: appState.viewBackgroundColor || "#ffffff",
        },
        files: currentFiles,
      });
      await api.updateDrawing(drawingId, { preview: svg.outerHTML });
    } catch (err) {
      console.error("Failed to save preview", err);
    }
  };

  saveLibraryRef.current = async (items: any[]) => {
    if (!user) return;
    try {
      await api.updateLibrary(items);
    } catch (err) {
      console.error("Failed to save library", err);
      if (api.isAxiosError(err) && err.response?.status === 401) return;
      toast.error("Failed to save library");
    }
  };

  // `maxWait` guarantees a save fires at least every couple seconds even
  // during continuous editing. A plain debounce only fires `wait`ms after
  // the LAST change, so uninterrupted typing/drawing (no pause longer than
  // `wait`) would never autosave — and on a mobile PWA that is then
  // closed/killed, all of those edits are lost because the pending timer is
  // frozen and discarded. The optimistic local cache (written before the
  // network attempt) is the primary safety net; maxWait caps the worst-case
  // window between caches. For a note-taking app 500ms/2000ms balances
  // responsiveness with not hammering IndexedDB on every keystroke.
  const debouncedSave = useCallback(
    debounce((drawingId, elements, appState, files) => {
      enqueueSceneSave(drawingId, elements, appState, files);
    }, 500, { maxWait: 2000 }),
    [enqueueSceneSave],
  );
  refs.debouncedSave.current = debouncedSave;

  const debouncedSavePreview = useCallback(
    debounce((drawingId: string) => {
      if (!savePreviewRef.current || !drawingId) return;
      if (refs.isUnmounting.current || refs.isSyncing.current) return;
      const expectedChangeAt = refs.lastLocalChangeAt.current;
      const run = () => {
        if (!savePreviewRef.current) return;
        if (refs.isUnmounting.current || refs.isSyncing.current) return;
        if (refs.lastLocalChangeAt.current !== expectedChangeAt) return;
        const appState = refs.latestAppState.current;
        if (!appState) return;
        void savePreviewRef.current(
          drawingId,
          refs.latestElements.current,
          appState,
          refs.latestFiles.current || {},
        );
      };
      const w = window as any;
      if (typeof w.requestIdleCallback === "function") {
        w.requestIdleCallback(run, { timeout: 2000 });
      } else {
        setTimeout(run, 0);
      }
    }, 30_000),
    [refs],
  );

  const debouncedSaveLibrary = useCallback(
    debounce((items: any[]) => {
      if (saveLibraryRef.current) saveLibraryRef.current(items);
    }, 1000),
    [],
  );

  useEffect(() => {
    return () => {
      debouncedSave.cancel();
      debouncedSavePreview.cancel();
    };
  }, [debouncedSave, debouncedSavePreview]);

  return {
    debouncedSave,
    debouncedSaveLibrary,
    debouncedSavePreview,
    enqueueSceneSave,
    saveDataRef,
    savePreviewRef,
  };
};
