import { useCallback, useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import * as api from "../../api";
import { getPersistedAppState, hasRenderableElements, raceTimeout } from "./shared";
import { cacheDrawing, getCachedDrawing } from "../../db/offline-db";

type AccessLevel = "none" | "view" | "edit" | "owner";

// Cap network loads when there is no cached drawing to show. On an
// unreachable network (iOS standalone PWA `navigator.onLine` can report
// `true` with no connectivity), the default axios timeout (15s) makes the
// editor appear frozen on a blank loader. 8s keeps a slow-but-healthy
// network working while failing fast when offline so the cache fallback /
// error appears quickly.
const DRAWING_LOAD_TIMEOUT_MS = 8000;

type SceneLoaderParams = {
  id: string | undefined;
  user: unknown;
  location: {
    pathname: string;
    search: string;
    hash: string;
  };
  navigate: NavigateFunction;
  refs: {
    elementVersionMap: MutableRefObject<Map<string, any>>;
    saveQueue: MutableRefObject<Promise<void>>;
    latestElements: MutableRefObject<readonly any[]>;
    initialSceneElements: MutableRefObject<readonly any[]>;
    latestFiles: MutableRefObject<any>;
    lastSyncedFiles: MutableRefObject<Record<string, any>>;
    lastSyncedElementOrderSig: MutableRefObject<string>;
    lastPersistedFiles: MutableRefObject<Record<string, any>>;
    currentDrawingVersion: MutableRefObject<number | null>;
    lastPersistedElements: MutableRefObject<readonly any[]>;
    suspiciousBlankLoad: MutableRefObject<boolean>;
    hasSceneChangesSinceLoad: MutableRefObject<boolean>;
    excalidrawAPI: MutableRefObject<any>;
    latestAppState: MutableRefObject<any>;
    isBootstrappingScene: MutableRefObject<boolean>;
    hasHydratedInitialScene: MutableRefObject<boolean>;
  };
  setAccessLevel: (accessLevel: AccessLevel) => void;
  setDrawingName: (name: string) => void;
  setInitialData: (data: any) => void;
  setIsReady: (ready: boolean) => void;
  setIsSceneLoading: (loading: boolean) => void;
  setLoadError: (error: string | null) => void;
  recordElementVersion: (element: any) => void;
};

const buildEmptyScene = () => ({
  elements: [],
  appState: {
    viewBackgroundColor: "#ffffff",
    gridSize: null,
    collaborators: new Map(),
  },
  files: {},
  scrollToContent: true,
});

export const useEditorSceneLoader = ({
  id,
  user,
  location,
  navigate,
  refs,
  setAccessLevel,
  setDrawingName,
  setInitialData,
  setIsReady,
  setIsSceneLoading,
  setLoadError,
  recordElementVersion,
}: SceneLoaderParams) => {
  const resetRefs = useCallback(() => {
    refs.isBootstrappingScene.current = true;
    refs.hasHydratedInitialScene.current = false;
    refs.elementVersionMap.current.clear();
    refs.saveQueue.current = Promise.resolve();
    refs.latestElements.current = [];
    refs.initialSceneElements.current = [];
    refs.latestFiles.current = {};
    refs.lastSyncedFiles.current = {};
    refs.lastSyncedElementOrderSig.current = "";
    refs.lastPersistedFiles.current = {};
    refs.currentDrawingVersion.current = null;
    refs.lastPersistedElements.current = [];
    refs.suspiciousBlankLoad.current = false;
    refs.hasSceneChangesSinceLoad.current = false;
    refs.excalidrawAPI.current = null;
  }, [refs]);

  useEffect(() => {
    resetRefs();
    setIsReady(false);
    setIsSceneLoading(true);
    setLoadError(null);
    setInitialData(null);

    const loadData = async () => {
      if (!id) {
        setInitialData(buildEmptyScene());
        setIsSceneLoading(false);
        return;
      }

      // Cache-first: ALWAYS check IndexedDB before any network call.
      // On iOS standalone PWAs, navigator.onLine is unreliable in airplane
      // mode (can report true with no connectivity). Loading from cache
      // first makes the editor open instantly for previously-viewed drawings
      // regardless of network state.
      let loadedFromCache = false;
      try {
        const cached = await getCachedDrawing(id);
        if (cached) {
          const elements = cached.elements || [];
          const files = cached.files || {};
          const hasPreview =
            typeof cached.preview === "string" && cached.preview.trim().length > 0;
          const loadedRenderable = hasRenderableElements(elements);
          refs.suspiciousBlankLoad.current = !loadedRenderable && hasPreview;
          refs.hasSceneChangesSinceLoad.current = false;
          refs.latestElements.current = elements;
          refs.initialSceneElements.current = elements;
          refs.latestFiles.current = files;
          refs.lastSyncedFiles.current = files;
          refs.lastPersistedFiles.current = files;
          refs.currentDrawingVersion.current =
            typeof cached.version === "number" ? cached.version : null;
          refs.lastPersistedElements.current = elements;
          elements.forEach((element: any) => recordElementVersion(element));
          const persistedAppState = getPersistedAppState(cached.appState || {});
          const hydratedAppState = {
            ...persistedAppState,
            collaborators: new Map(),
          };
          refs.latestAppState.current = hydratedAppState;
          setDrawingName(cached.name || "Untitled Drawing");
          setAccessLevel("owner");
          setInitialData({
            elements,
            appState: hydratedAppState,
            files,
            scrollToContent: true,
            libraryItems: [],
          });
          setIsSceneLoading(false);
          loadedFromCache = true;

          // If offline, we're done — don't attempt a network refresh.
          const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
          if (isOffline) {
            toast.info("Offline mode: showing cached version. Changes will sync when reconnected.");
            return;
          }
        }
      } catch {
        // IndexedDB unavailable
      }

      if (loadedFromCache) {
        // Cache was shown instantly. Now try a background network refresh
        // to update the IndexedDB cache for next time. We do NOT touch the
        // editor's refs/state to avoid race conditions if the user has
        // already started editing. The next open will get the latest version.
        try {
          const data = await raceTimeout(
            api.getDrawing(id),
            DRAWING_LOAD_TIMEOUT_MS,
          );
          cacheDrawing(data).catch(() => {});
          // Update the version ref so saves use the correct server version
          // for optimistic concurrency — but only if the user hasn't
          // started editing yet.
          if (!refs.hasSceneChangesSinceLoad.current) {
            refs.currentDrawingVersion.current =
              typeof data.version === "number" ? data.version : null;
          }
        } catch {
          // Network refresh failed — cached version remains. Silent.
        }
        return;
      }

      // No cached drawing — must use the network (first-time open).
      try {
        const libraryItemsPromise = user
          ? raceTimeout(api.getLibrary(), DRAWING_LOAD_TIMEOUT_MS).catch((err) => {
              console.warn("Failed to load library, using empty:", err);
              return [];
            })
          : Promise.resolve([]);
        const [data, libraryItems] = await Promise.all([
          raceTimeout(api.getDrawing(id), DRAWING_LOAD_TIMEOUT_MS),
          libraryItemsPromise,
        ]);
        cacheDrawing(data).catch(() => {});
        setDrawingName(data.name);
        setAccessLevel(
          data.accessLevel === "view" ||
            data.accessLevel === "edit" ||
            data.accessLevel === "owner"
            ? data.accessLevel
            : "owner",
        );
        const elements = data.elements || [];
        const files = data.files || {};
        const hasPreview =
          typeof data.preview === "string" && data.preview.trim().length > 0;
        const loadedRenderable = hasRenderableElements(elements);
        refs.suspiciousBlankLoad.current = !loadedRenderable && hasPreview;
        refs.hasSceneChangesSinceLoad.current = false;
        if (import.meta.env.DEV) {
          console.log("[Editor] Loaded drawing", {
            drawingId: id,
            elementCount: elements.length,
            loadedRenderable,
            hasPreview,
            version: data.version ?? null,
            suspiciousBlankLoad: refs.suspiciousBlankLoad.current,
          });
        }
        refs.latestElements.current = elements;
        refs.initialSceneElements.current = elements;
        refs.latestFiles.current = files;
        refs.lastSyncedFiles.current = files;
        refs.lastPersistedFiles.current = files;
        refs.currentDrawingVersion.current =
          typeof data.version === "number" ? data.version : null;
        refs.lastPersistedElements.current = elements;
        elements.forEach((element: any) => recordElementVersion(element));
        const persistedAppState = getPersistedAppState(data.appState || {});
        const hydratedAppState = {
          ...persistedAppState,
          collaborators: new Map(),
        };
        refs.latestAppState.current = hydratedAppState;
        setInitialData({
          elements,
          appState: hydratedAppState,
          files,
          scrollToContent: true,
          libraryItems,
        });
      } catch (err) {
        console.error("Failed to load drawing", err);

        const isNetworkError = api.isNetworkError(err);

        if (isNetworkError && id) {
          try {
            const cached = await getCachedDrawing(id);
            if (cached) {
              const elements = cached.elements || [];
              const files = cached.files || {};
              const hasPreview =
                typeof cached.preview === "string" && cached.preview.trim().length > 0;
              const loadedRenderable = hasRenderableElements(elements);
              refs.suspiciousBlankLoad.current = !loadedRenderable && hasPreview;
              refs.hasSceneChangesSinceLoad.current = false;
              refs.latestElements.current = elements;
              refs.initialSceneElements.current = elements;
              refs.latestFiles.current = files;
              refs.lastSyncedFiles.current = files;
              refs.lastPersistedFiles.current = files;
              refs.currentDrawingVersion.current =
                typeof cached.version === "number" ? cached.version : null;
              refs.lastPersistedElements.current = elements;
              elements.forEach((element: any) => recordElementVersion(element));
              const persistedAppState = getPersistedAppState(cached.appState || {});
              const hydratedAppState = {
                ...persistedAppState,
                collaborators: new Map(),
              };
              refs.latestAppState.current = hydratedAppState;
              setDrawingName(cached.name);
              setAccessLevel("owner");
              setInitialData({
                elements,
                appState: hydratedAppState,
                files,
                scrollToContent: true,
                libraryItems: [],
              });
              toast.info("Offline mode: showing cached version. Changes will sync when reconnected.");
              return;
            }
          } catch {
            // IndexedDB unavailable
          }
        }

        let message = "Failed to load drawing";
        if (api.isAxiosError(err)) {
          const responseMessage =
            typeof err.response?.data?.message === "string"
              ? err.response.data.message
              : null;
          if (responseMessage) {
            message = responseMessage;
          } else if (err.response?.status === 403) {
            message = "You do not have access to this drawing";
          } else if (err.response?.status === 404) {
            message = "Drawing not found";
          }
          if (
            err.response?.status === 403 &&
            id &&
            location.pathname.startsWith("/editor/")
          ) {
            navigate(`/shared/${id}${location.search}${location.hash}`, {
              replace: true,
            });
            return;
          }
        }
        toast.error(message);
        refs.latestElements.current = [];
        refs.initialSceneElements.current = [];
        refs.latestFiles.current = {};
        refs.lastSyncedFiles.current = {};
        refs.lastSyncedElementOrderSig.current = "";
        refs.lastPersistedFiles.current = {};
        refs.currentDrawingVersion.current = null;
        refs.lastPersistedElements.current = [];
        refs.suspiciousBlankLoad.current = false;
        refs.hasSceneChangesSinceLoad.current = false;
        setLoadError(message);
        setInitialData(null);
      } finally {
        setIsSceneLoading(false);
      }
    };

    loadData();
  }, [
    id,
    location.hash,
    location.pathname,
    location.search,
    navigate,
    recordElementVersion,
    refs,
    resetRefs,
    setAccessLevel,
    setDrawingName,
    setInitialData,
    setIsReady,
    setIsSceneLoading,
    setLoadError,
    user,
  ]);
};
