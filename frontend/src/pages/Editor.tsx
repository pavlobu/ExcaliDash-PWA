import React, { useCallback, useEffect, useState, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { getInitialLangCode } from "../components/LanguageSelector";
import type { UserIdentity } from "../utils/identity";
import type { DrawingSnapshotFull } from "../api";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { getFilesDelta, getPersistedAppState } from "./editor/shared";
import { removeCachedDrawing } from "../db/offline-db";
import { useEditorChrome } from "./editor/useEditorChrome";
import { useEditorAutoHide } from "./editor/useEditorAutoHide";
import { useEditorIdentity } from "./editor/useEditorIdentity";
import { EditorDialogs } from "./editor/EditorDialogs";
import { EditorView } from "./editor/EditorView";
import { useLibraryImportFromUrl } from "./editor/useLibraryImportFromUrl";
import { useEditorSnapshotGuards } from "./editor/useEditorSnapshotGuards";
import { useEditorSceneLoader } from "./editor/useEditorSceneLoader";
import { useEditorCollaboration } from "./editor/useEditorCollaboration";
import { useEditorPersistence } from "./editor/useEditorPersistence";
import { useEditorOfflineFlush } from "./editor/useEditorOfflineFlush";
import { useEditorCanvasHandlers } from "./editor/useEditorCanvasHandlers";
import { useEditorCommands } from "./editor/useEditorCommands";
import { useEditorElementTracking } from "./editor/useEditorElementTracking";
import { useEditorBroadcast } from "./editor/useEditorBroadcast";
import { useEditorAutoLock } from "./editor/useEditorAutoLock";
export const Editor: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme } = useTheme();
  const { user } = useAuth();
  const [accessLevel, setAccessLevel] = useState<
    "none" | "view" | "edit" | "owner"
  >("none");
  const canEdit = accessLevel === "edit" || accessLevel === "owner";
  const [drawingName, setDrawingName] = useState("Drawing Editor");
  const drawingNameRef = useRef(drawingName);
  useEffect(() => {
    drawingNameRef.current = drawingName;
  }, [drawingName]);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [initialData, setInitialData] = useState<any>(null);
  const [isSceneLoading, setIsSceneLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSavingOnLeave, setIsSavingOnLeave] = useState(false);
  const { autoHideEnabled, setAutoHideEnabled } = useEditorAutoHide(id);
  const [isLocked, setIsLocked] = useState(false);
  const [isSceneHydrated, setIsSceneHydrated] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [langCode, setLangCode] = useState(getInitialLangCode);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [activePreview, setActivePreview] = useState<{
    version: number;
    createdAt: string;
  } | null>(null);
  const previewBackup = useRef<{
    elements: readonly any[];
    appState: any;
    files: any;
  } | null>(null);
  const { isHeaderVisible, setIsHeaderVisible } = useEditorChrome({
    drawingName,
    autoHideEnabled,
    isRenaming,
  });
  const me: UserIdentity = useEditorIdentity(user);
  const [isReady, setIsReady] = useState(false);
  const {
    computeElementOrderSig,
    elementVersionMap,
    hasElementChanged,
    recordElementVersion,
  } = useEditorElementTracking();
  const isBootstrappingScene = useRef(true);
  const hasHydratedInitialScene = useRef(false);
  const isUnmounting = useRef(false);
  const latestElementsRef = useRef<readonly any[]>([]);
  const initialSceneElementsRef = useRef<readonly any[]>([]);
  const latestFilesRef = useRef<any>(null);
  const lastSyncedFilesRef = useRef<Record<string, any>>({});
  const lastSyncedElementOrderSigRef = useRef<string>("");
  const lastPersistedFilesRef = useRef<Record<string, any>>({});
  const latestAppStateRef = useRef<any>(null);
  const debouncedSaveRef = useRef<
    | ((
        drawingId: string,
        elements: readonly any[],
        appState: any,
        files?: Record<string, any>,
      ) => void)
    | null
  >(null);
  const currentDrawingVersionRef = useRef<number | null>(null);
  const lastPersistedElementsRef = useRef<readonly any[]>([]);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const patchedAddFilesApisRef = useRef<WeakSet<object>>(new WeakSet());
  const suspiciousBlankLoadRef = useRef(false);
  const hasSceneChangesSinceLoadRef = useRef(false);
  const lastLocalChangeAtRef = useRef<number>(0);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const excalidrawAPI = useRef<any>(null);
  const { resolveSafeSnapshot, normalizeImageElementStatus } =
    useEditorSnapshotGuards({
      lastPersistedElementsRef,
      initialSceneElementsRef,
      latestElementsRef,
    });
  useEffect(() => {
    isUnmounting.current = false;
    return () => {
      isUnmounting.current = true;
    };
  }, []);
  useEffect(() => {
    setIsLocked(false);
    setIsSceneHydrated(false);
  }, [id]);
  const handleSocketAccessDenied = useCallback(() => {
    if (!id || !location.pathname.startsWith("/editor/")) return;
    navigate(`/shared/${id}${location.search}${location.hash}`, {
      replace: true,
    });
  }, [id, location.hash, location.pathname, location.search, navigate]);
  const { peers, socketMeRef, socketRef, isSyncing: isSyncingRef, onPointerUpdate } =
    useEditorCollaboration({
      drawingId: id,
      me,
      isReady,
      excalidrawAPI,
      editorContainerRef,
      lastSyncedFilesRef,
      lastSyncedElementOrderSigRef,
      latestElementsRef,
      latestFilesRef,
      computeElementOrderSig,
      recordElementVersion,
      onAccessDenied: handleSocketAccessDenied,
    });
  const emitFilesDeltaIfNeeded = useCallback(
    (nextFiles: Record<string, any>) => {
      if (!socketRef.current || !id) return false;
      const filesDelta = getFilesDelta(
        lastSyncedFilesRef.current,
        nextFiles || {},
      );
      if (Object.keys(filesDelta).length === 0) return false;
      latestFilesRef.current = nextFiles;
      lastSyncedFilesRef.current = nextFiles;
      socketRef.current.emit("element-update", {
        drawingId: id,
        elements: [],
        files: filesDelta,
        userId: socketMeRef.current.id,
      });
      return true;
    },
    [id, socketMeRef, socketRef],
  );
  const setExcalidrawAPI = useCallback(
    (api: any) => {
      excalidrawAPI.current = api;
      if (import.meta.env.DEV) {
        (window as any).__EXCALIDASH_EXCALIDRAW_API__ = api;
      }
      if (
        api &&
        typeof api.addFiles === "function" &&
        !patchedAddFilesApisRef.current.has(api as object)
      ) {
        patchedAddFilesApisRef.current.add(api as object);
        const originalAddFiles = api.addFiles.bind(api);
        api.addFiles = (filesInput: Record<string, any> | any[]) => {
          const normalizedFiles = Array.isArray(filesInput)
            ? filesInput
            : Object.values(filesInput || {});
          originalAddFiles(normalizedFiles);
          if (isSyncingRef.current) return;
          const nextFiles = api.getFiles?.() || {};
          const didEmit = emitFilesDeltaIfNeeded(nextFiles);
          if (
            didEmit &&
            id &&
            latestAppStateRef.current &&
            debouncedSaveRef.current
          ) {
            hasSceneChangesSinceLoadRef.current = true;
            debouncedSaveRef.current(
              id,
              latestElementsRef.current,
              latestAppStateRef.current,
              latestFilesRef.current || {},
            );
          }
        };
      }
      setIsReady(true);
    },
    [emitFilesDeltaIfNeeded, id, isSyncingRef],
  );
  useLibraryImportFromUrl({ excalidrawAPIRef: excalidrawAPI, isReady, user });
  const persistenceRefs = React.useMemo(
    () => ({
      currentDrawingVersion: currentDrawingVersionRef,
      debouncedSave: debouncedSaveRef,
      drawingName: drawingNameRef,
      excalidrawAPI,
      isSyncing: isSyncingRef,
      isUnmounting,
      lastLocalChangeAt: lastLocalChangeAtRef,
      lastPersistedElements: lastPersistedElementsRef,
      lastPersistedFiles: lastPersistedFilesRef,
      lastSyncedFiles: lastSyncedFilesRef,
      latestAppState: latestAppStateRef,
      latestElements: latestElementsRef,
      latestFiles: latestFilesRef,
      saveQueue: saveQueueRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
    }),
    [isSyncingRef],
  );
  const {
    debouncedSave,
    debouncedSaveLibrary,
    debouncedSavePreview,
    enqueueSceneSave,
    saveDataRef,
    savePreviewRef,
  } = useEditorPersistence({
    refs: persistenceRefs,
    user,
    normalizeImageElementStatus,
    resolveSafeSnapshot,
  });
  useEditorOfflineFlush({
    drawingId: id,
    canEdit,
    refs: {
      excalidrawAPI,
      debouncedSave: debouncedSaveRef,
      drawingName: drawingNameRef,
      currentDrawingVersion: currentDrawingVersionRef,
      latestAppState: latestAppStateRef,
      latestFiles: latestFilesRef,
      latestElements: latestElementsRef,
      lastPersistedElements: lastPersistedElementsRef,
      hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
      isUnmounting,
    },
    resolveSafeSnapshot,
    normalizeImageElementStatus,
  });
  const markSceneChangedSinceLoad = useCallback(() => {
    hasSceneChangesSinceLoadRef.current = true;
  }, []);
  const broadcastChanges = useEditorBroadcast({
    drawingId: id,
    excalidrawAPI,
    lastLocalChangeAtRef,
    lastSyncedElementOrderSigRef,
    lastSyncedFilesRef,
    latestAppStateRef,
    latestFilesRef,
    socketMeRef,
    socketRef,
    debouncedSave,
    debouncedSavePreview,
    computeElementOrderSig,
    hasElementChanged,
    normalizeImageElementStatus,
    recordElementVersion,
    setHasSceneChangesSinceLoad: markSceneChangedSinceLoad,
  });
  const sceneLoaderRefs = React.useMemo(
    () => ({
      elementVersionMap,
      saveQueue: saveQueueRef,
      latestElements: latestElementsRef,
      initialSceneElements: initialSceneElementsRef,
      latestFiles: latestFilesRef,
      lastSyncedFiles: lastSyncedFilesRef,
      lastSyncedElementOrderSig: lastSyncedElementOrderSigRef,
      lastPersistedFiles: lastPersistedFilesRef,
      currentDrawingVersion: currentDrawingVersionRef,
      lastPersistedElements: lastPersistedElementsRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
      hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
      excalidrawAPI,
      isSyncing: isSyncingRef,
      latestAppState: latestAppStateRef,
      isBootstrappingScene,
      hasHydratedInitialScene,
    }),
    [elementVersionMap, isSyncingRef],
  );
  useEditorSceneLoader({
    id,
    user,
    location,
    navigate,
    refs: sceneLoaderRefs,
    setAccessLevel,
    setDrawingName,
    setInitialData,
    setIsReady,
    setIsSceneLoading,
    setLoadError,
    recordElementVersion,
  });
  const canvasHandlerRefs = React.useMemo(
    () => ({
      debouncedSave: debouncedSaveRef,
      excalidrawAPI,
      hasHydratedInitialScene,
      hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
      initialSceneElements: initialSceneElementsRef,
      isBootstrappingScene,
      isSyncing: isSyncingRef,
      isUnmounting,
      lastLocalChangeAt: lastLocalChangeAtRef,
      latestAppState: latestAppStateRef,
      latestElements: latestElementsRef,
      latestFiles: latestFilesRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
    }),
    [isSyncingRef],
  );
  const { handleCanvasChange, handleCanvasDropCapture } =
    useEditorCanvasHandlers({
      canEdit,
      debouncedSavePreview,
      drawingId: id,
      emitFilesDeltaIfNeeded,
      isReady,
      refs: canvasHandlerRefs,
      resolveSafeSnapshot,
      broadcastChanges,
      onSceneHydrated: useCallback(() => setIsSceneHydrated(true), []),
    });
  const commandRefs = React.useMemo(
    () => ({
      currentDrawingVersion: currentDrawingVersionRef,
      drawingName: drawingNameRef,
      excalidrawAPI,
      hasSceneChangesSinceLoad: hasSceneChangesSinceLoadRef,
      latestFiles: latestFilesRef,
      saveData: saveDataRef,
      savePreview: savePreviewRef,
      suspiciousBlankLoad: suspiciousBlankLoadRef,
    }),
    [saveDataRef, savePreviewRef],
  );
  const {
    handleBackClick,
    handleExportClick,
    handleLibraryChange,
    handleRenameBlur,
    handleRenameCancel,
    handleRenameStart,
    handleRenameSubmit,
    handleToggleAutoHide,
    handleToggleLock,
  } = useEditorCommands({
    autoHideEnabled,
    canEdit,
    debouncedSaveLibrary,
    drawingId: id,
    drawingName,
    enqueueSceneSave,
    isSavingOnLeave,
    newName,
    refs: commandRefs,
    resolveSafeSnapshot,
    setAutoHideEnabled,
    setDrawingName,
    setIsHeaderVisible,
    setIsRenaming,
    setIsSavingOnLeave,
    setNewName,
    setIsLocked,
    user,
  });

  useEditorAutoLock({
    drawingId: id,
    excalidrawAPI,
    isReady,
    isSceneHydrated,
    canEdit,
    setIsLocked,
  });

  const handlePreviewSnapshot = useCallback(
    (snapshot: DrawingSnapshotFull | null) => {
      const exApi = excalidrawAPI.current;
      if (!exApi) return;
      if (snapshot) {
        // Entering preview: set isSyncing and KEEP IT TRUE for the entire
        // preview duration. Excalidraw fires onChange on later render
        // cycles (pointer move, scroll, internal reconciliation) — if
        // isSyncing were reset too early, handleCanvasChange would process
        // Excalidraw's committed (pre-preview) state and revert the canvas.
        isSyncingRef.current = true;
        if (!previewBackup.current) {
          previewBackup.current = {
            elements: exApi.getSceneElementsIncludingDeleted(),
            appState: exApi.getAppState(),
            files: exApi.getFiles(),
          };
        }
        const elements = Array.isArray(snapshot.elements)
          ? snapshot.elements
          : [];
        const files = snapshot.files || {};
        if (Object.keys(files).length > 0) {
          exApi.addFiles(Object.values(files));
        }
        exApi.updateScene({
          elements,
          appState: {
            ...getPersistedAppState(snapshot.appState),
            collaborators: new Map(),
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        setActivePreview({
          version: snapshot.version,
          createdAt: snapshot.createdAt,
        });
        // Do NOT reset isSyncing here — it stays true until the user
        // exits the preview (see the null branch below).
      } else {
        // Exiting preview: restore the backed-up canvas, then reset
        // isSyncing on the next tick so the restore's onChange is also
        // suppressed.
        if (previewBackup.current) {
          exApi.updateScene({
            elements: previewBackup.current.elements as any[],
            appState: {
              ...getPersistedAppState(previewBackup.current.appState),
              collaborators: new Map(),
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          if (previewBackup.current.files) {
            exApi.addFiles(Object.values(previewBackup.current.files));
          }
          previewBackup.current = null;
        }
        setActivePreview(null);
        setTimeout(() => {
          isSyncingRef.current = false;
        }, 0);
      }
    },
    [excalidrawAPI, isSyncingRef, previewBackup],
  );

  const handleExitPreview = useCallback(() => {
    handlePreviewSnapshot(null);
  }, [handlePreviewSnapshot]);

  const handleRestoreSnapshot = useCallback(async () => {
    // Clear the local IndexedDB cache so the cache-first scene loader
    // falls through to the network on reload. Without this, the stale
    // pre-restore cached version is shown instead of the restored version.
    if (id) {
      try {
        await removeCachedDrawing(id);
      } catch {
        // Best-effort — proceed with reload regardless.
      }
    }
    previewBackup.current = null;
    setActivePreview(null);
    window.location.reload();
  }, [id, previewBackup]);

  const handleBackWithPreviewGuard = useCallback(() => {
    if (activePreview) {
      handlePreviewSnapshot(null);
    }
    void handleBackClick();
  }, [activePreview, handleBackClick, handlePreviewSnapshot]);

  return (
    <>
      <EditorView
        id={id}
        accessLevel={accessLevel}
        activePreview={activePreview}
        autoHideEnabled={autoHideEnabled}
        canEdit={canEdit}
        drawingName={drawingName}
        editorContainerRef={editorContainerRef}
        initialData={initialData}
        isHeaderVisible={isHeaderVisible}
        isLocked={isLocked}
        isRenaming={isRenaming}
        isSavingOnLeave={isSavingOnLeave}
        isSceneLoading={isSceneLoading}
        langCode={langCode}
        loadError={loadError}
        me={me}
        newName={newName}
        peers={peers}
        theme={theme}
        onBackClick={handleBackWithPreviewGuard}
        onCanvasChange={handleCanvasChange}
        onCanvasDropCapture={handleCanvasDropCapture}
        onExitPreview={handleExitPreview}
        onExportClick={handleExportClick}
        onLibraryChange={handleLibraryChange}
        onNavigateHome={() => navigate("/")}
        onNewNameChange={setNewName}
        onPointerUpdate={onPointerUpdate}
        onRenameBlur={handleRenameBlur}
        onRenameCancel={handleRenameCancel}
        onRenameStart={handleRenameStart}
        onRenameSubmit={handleRenameSubmit}
        onSetExcalidrawAPI={setExcalidrawAPI}
        onSetLangCode={setLangCode}
        onShareOpen={() => setIsShareOpen(true)}
        onHistoryOpen={() => setIsHistoryOpen(true)}
        onToggleAutoHide={handleToggleAutoHide}
        onToggleLock={handleToggleLock}
        onHideHeader={() => setIsHeaderVisible(false)}
      />
      <EditorDialogs
        drawingId={id}
        drawingName={drawingName}
        isHistoryOpen={isHistoryOpen}
        isShareOpen={isShareOpen}
        activePreview={activePreview}
        onPreview={handlePreviewSnapshot}
        onRestore={handleRestoreSnapshot}
        onCloseHistory={() => setIsHistoryOpen(false)}
        onCloseShare={() => setIsShareOpen(false)}
      />
    </>
  );
};
