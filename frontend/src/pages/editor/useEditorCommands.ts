import { useCallback, useEffect, useRef } from "react";
import type { FormEvent, MutableRefObject } from "react";
import { useNavigate } from "react-router-dom";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { toast } from "sonner";
import * as api from "../../api";
import { exportFromEditor } from "../../utils/exportUtils";
import { hasRenderableElements, raceTimeout } from "./shared";
import {
  cacheDrawing,
  enqueuePendingOp,
  updateCachedDrawing,
  updateCachedDrawingSummary,
} from "../../db/offline-db";

type EditorCommandRefs = {
  currentDrawingVersion: MutableRefObject<number | null>;
  drawingName: MutableRefObject<string>;
  excalidrawAPI: MutableRefObject<any>;
  hasSceneChangesSinceLoad: MutableRefObject<boolean>;
  latestFiles: MutableRefObject<any>;
  saveData: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => Promise<void>)
    | null
  >;
  savePreview: MutableRefObject<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files: any,
      ) => Promise<void>)
    | null
  >;
  suspiciousBlankLoad: MutableRefObject<boolean>;
};

type UseEditorCommandsParams = {
  autoHideEnabled: boolean;
  canEdit: boolean;
  debouncedSaveLibrary: (items: any[]) => void;
  drawingId: string | undefined;
  drawingName: string;
  isSavingOnLeave: boolean;
  newName: string;
  refs: EditorCommandRefs;
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    snapshot: readonly any[];
    prevented: boolean;
    staleEmptySnapshot: boolean;
    staleNonRenderableSnapshot: boolean;
  };
  enqueueSceneSave: (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files?: Record<string, any>,
    options?: { suppressErrors?: boolean },
  ) => Promise<void>;
  setAutoHideEnabled: (enabled: boolean) => void;
  setDrawingName: (name: string) => void;
  setIsHeaderVisible: (visible: boolean) => void;
  setIsRenaming: (isRenaming: boolean) => void;
  setIsSavingOnLeave: (isSaving: boolean) => void;
  setNewName: (name: string) => void;
  setIsLocked: (locked: boolean) => void;
  user: unknown;
};

export const useEditorCommands = ({
  autoHideEnabled,
  canEdit,
  debouncedSaveLibrary,
  drawingId,
  drawingName,
  enqueueSceneSave,
  isSavingOnLeave,
  newName,
  refs,
  resolveSafeSnapshot,
  setAutoHideEnabled,
  setDrawingName,
  setIsHeaderVisible,
  setIsRenaming,
  setIsSavingOnLeave,
  setNewName,
  setIsLocked,
  user,
}: UseEditorCommandsParams) => {
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (!canEdit) return;
        if (
          !(
            refs.excalidrawAPI.current &&
            refs.saveData.current &&
            refs.savePreview.current
          )
        ) {
          return;
        }
        if (!drawingId) return;
        const elements =
          refs.excalidrawAPI.current.getSceneElementsIncludingDeleted();
        const { snapshot: safeElements } = resolveSafeSnapshot(elements);
        const appState = refs.excalidrawAPI.current.getAppState();
        const files = refs.excalidrawAPI.current.getFiles() || {};
        refs.latestFiles.current = files;
        await enqueueSceneSave(drawingId, safeElements, appState, files);
        refs.savePreview.current(drawingId, safeElements, appState, files);
        toast.success("Saved changes to server");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canEdit, drawingId, enqueueSceneSave, refs, resolveSafeSnapshot]);

  // Guards against double-execution: pressing Enter submits the form and
  // then blurs the input (because setIsRenaming unmounts it). Without this
  // ref the commit would fire twice. It is reset in handleRenameStart.
  const renameCommittedRef = useRef(false);

  // Tracks the in-flight rename API promise so handleBackClick can await
  // it before navigating to the dashboard. Without this, the rename
  // request may not have reached the server when the dashboard fetches
  // its drawing list, causing the old name to appear.
  const pendingRenamePromiseRef = useRef<Promise<void> | null>(null);

  const commitRename = useCallback(async () => {
    if (renameCommittedRef.current) return;
    if (!canEdit || !drawingId) {
      setIsRenaming(false);
      return;
    }
    const trimmed = newName.trim();
    if (!trimmed || trimmed === drawingName) {
      renameCommittedRef.current = true;
      setIsRenaming(false);
      return;
    }
    renameCommittedRef.current = true;
    setDrawingName(trimmed);
    setIsRenaming(false);
    pendingRenamePromiseRef.current = (async () => {
      try {
        await api.updateDrawing(drawingId, { name: trimmed });
        // Keep IndexedDB caches consistent so a later offline reopen
        // (the editor loads cache-first) shows the new name.
        updateCachedDrawing(drawingId, { name: trimmed }).catch(() => {});
        updateCachedDrawingSummary(drawingId, { name: trimmed }).catch(() => {});
      } catch (err) {
        if (api.isNetworkError(err)) {
          try {
            // Update BOTH stores: the summary (dashboard list) AND the
            // full drawing cache (editor re-open). Without updating the
            // full cache, getCachedDrawing() returns the old name on
            // next offline open.
            await updateCachedDrawing(drawingId, { name: trimmed });
            await updateCachedDrawingSummary(drawingId, { name: trimmed });
            await enqueuePendingOp({
              drawingId,
              type: "update",
              payload: { name: trimmed },
            });
            toast.info("Offline: rename saved locally. Will sync when reconnected.");
          } catch (cacheErr) {
            console.error("Failed to cache offline rename:", cacheErr);
          }
          return;
        }
        console.error("Failed to rename", err);
      }
    })();
    await pendingRenamePromiseRef.current;
  }, [canEdit, drawingId, drawingName, newName, setDrawingName, setIsRenaming]);

  const handleRenameSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void commitRename();
    },
    [commitRename],
  );

  // On mobile, tapping outside the input fires blur — this should commit
  // the rename, not discard it. (Previously blur cancelled, so any rename
  // entered via touch was lost the moment the user dismissed the keyboard.)
  const handleRenameBlur = useCallback(() => {
    void commitRename();
  }, [commitRename]);

  const handleLibraryChange = useCallback(
    (items: readonly any[]) => {
      if (!canEdit || !user) return;
      debouncedSaveLibrary([...items]);
    },
    [canEdit, debouncedSaveLibrary, user],
  );

  // Cap how long the back button waits for an online scene save before it
  // falls back to a local (offline) save and navigates. iOS standalone PWA
  // `navigator.onLine` can report `true` with no connectivity; without this
  // cap, the network save hangs for the full axios timeout (15s) before the
  // save's own network-error handler runs, making the back button appear
  // frozen. The in-flight save is not cancelled — it continues in the
  // background and self-heals (cache + pending op) on failure.
  const SAVE_ON_LEAVE_TIMEOUT_MS = 3000;

  const handleBackClick = useCallback(async () => {
    if (isSavingOnLeave) return;
    setIsSavingOnLeave(true);
    let shouldNavigate = false;

    try {
      if (
        !(
          refs.excalidrawAPI.current &&
          refs.saveData.current &&
          refs.savePreview.current
        )
      ) {
        shouldNavigate = true;
      } else if (!canEdit || !refs.hasSceneChangesSinceLoad.current) {
        shouldNavigate = true;
      } else if (!drawingId) {
        shouldNavigate = true;
      } else {
        // Persist the current scene to IndexedDB and enqueue a pending op
        // so the changes survive a quick app close and sync when reconnected.
        // Defined here (after the !drawingId guard) so `drawingId` is narrowed
        // to string. Reused for the offline case and the online-save timeout
        // fallback.
        const saveLocally = async (
          safeElements: readonly any[],
          appState: any,
          files: Record<string, any>,
        ) => {
          try {
            const currentName = refs.drawingName.current || "Untitled Drawing";
            await cacheDrawing({
              id: drawingId,
              name: currentName,
              collectionId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              version: refs.currentDrawingVersion.current ?? 1,
              elements: Array.from(safeElements),
              appState,
              files: files || null,
              preview: null,
            });
            await updateCachedDrawingSummary(drawingId, {
              name: currentName,
              updatedAt: Date.now(),
            });
            await enqueuePendingOp({
              drawingId,
              type: "update",
              payload: {
                name: currentName,
                elements: Array.from(safeElements),
                appState,
                ...(Object.keys(files || {}).length > 0
                  ? { files }
                  : {}),
              },
            });
          } catch {
            // Best-effort cache — navigate anyway.
          }
        };
        const elements =
          refs.excalidrawAPI.current.getSceneElementsIncludingDeleted();
        const { snapshot: safeElements } = resolveSafeSnapshot(elements);
        const appState = refs.excalidrawAPI.current.getAppState();
        const files = refs.excalidrawAPI.current.getFiles() || {};
        refs.latestFiles.current = files;
        if (
          refs.suspiciousBlankLoad.current &&
          !hasRenderableElements(safeElements)
        ) {
          toast.warning(
            "Blank scene detected on load. Skipping save to protect existing data.",
          );
          shouldNavigate = true;
        } else {
          const isOffline =
            typeof navigator !== "undefined" && !navigator.onLine;
          if (isOffline) {
            // Offline: cache locally and navigate immediately. Skip the
            // network save which would hang for the full axios timeout
            // before failing, making the back button appear frozen.
            await saveLocally(safeElements, appState, files);
            toast.info("Offline: changes saved locally. Will sync when reconnected.");
            shouldNavigate = true;
          } else {
            // Online: save to the server, but cap the wait so an unreachable
            // network (navigator.onLine unreliable on iOS) does not freeze
            // the back button. If the save does not settle in time, persist
            // locally and navigate; the in-flight save keeps running in the
            // background and self-heals on failure.
            try {
              await raceTimeout(
                Promise.all([
                  enqueueSceneSave(drawingId, safeElements, appState, files, {
                    suppressErrors: false,
                  }),
                  refs.savePreview.current(drawingId, safeElements, appState, files),
                ]),
                SAVE_ON_LEAVE_TIMEOUT_MS,
              );
              shouldNavigate = true;
            } catch (err) {
              const isTimeout = err instanceof Error && err.message === "timeout";
              if (isTimeout) {
                await saveLocally(safeElements, appState, files);
                toast.info("Network slow — changes saved locally. Will sync when reconnected.");
              }
              // Non-timeout errors (e.g. version conflict already retried
              // inside the save) should not be masked as offline; just leave.
              shouldNavigate = true;
            }
          }
        }
      }
    } catch (err) {
      console.error("Failed to save on back navigation", err);
      // Even if save fails, navigate back — user intent is to leave.
      shouldNavigate = true;
    } finally {
      setIsSavingOnLeave(false);
    }
    // Wait for any pending rename to reach the server before navigating
    // to the dashboard. Without this, the dashboard may fetch its drawing
    // list before the rename has been persisted, showing the old name.
    if (pendingRenamePromiseRef.current) {
      try {
        await pendingRenamePromiseRef.current;
      } catch {
        // Already handled in commitRename
      }
      pendingRenamePromiseRef.current = null;
    }
    if (shouldNavigate) navigate("/");
  }, [
    canEdit,
    drawingId,
    enqueueSceneSave,
    isSavingOnLeave,
    navigate,
    refs,
    resolveSafeSnapshot,
    setIsSavingOnLeave,
  ]);

  const handleExportClick = useCallback(() => {
    if (!refs.excalidrawAPI.current) return;
    const elements =
      refs.excalidrawAPI.current.getSceneElementsIncludingDeleted();
    const appState = refs.excalidrawAPI.current.getAppState();
    const files = refs.excalidrawAPI.current.getFiles() || {};
    exportFromEditor(drawingName, elements, appState, files);
    toast.success("Drawing exported");
  }, [drawingName, refs]);

  const handleToggleAutoHide = useCallback(() => {
    setAutoHideEnabled(!autoHideEnabled);
    setIsHeaderVisible(true);
  }, [autoHideEnabled, setAutoHideEnabled, setIsHeaderVisible]);

  const handleRenameStart = useCallback(() => {
    if (!canEdit) return;
    renameCommittedRef.current = false;
    setNewName(drawingName);
    setIsRenaming(true);
  }, [canEdit, drawingName, setIsRenaming, setNewName]);

  const handleRenameCancel = useCallback(() => {
    renameCommittedRef.current = true;
    setIsRenaming(false);
  }, [setIsRenaming]);

  const handleToggleLock = useCallback(() => {
    if (!canEdit) return;
    const api = refs.excalidrawAPI.current;
    if (!api || typeof api.getSceneElementsIncludingDeleted !== "function") return;
    const elements = api.getSceneElementsIncludingDeleted() ?? [];
    if (!hasRenderableElements(elements)) return;
    const allLocked = elements.every(
      (el: any) => el?.isDeleted === true || el?.locked === true,
    );
    const nextLocked = !allLocked;
    const updatedElements = elements.map((el: any) =>
      el?.isDeleted === true ? el : { ...el, locked: nextLocked },
    );
    api.updateScene({
      elements: updatedElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setIsLocked(nextLocked);
  }, [canEdit, refs, setIsLocked]);

  return {
    handleBackClick,
    handleExportClick,
    handleLibraryChange,
    handleRenameBlur,
    handleRenameCancel,
    handleRenameStart,
    handleRenameSubmit,
    handleToggleAutoHide,
    handleToggleLock,
  };
};
