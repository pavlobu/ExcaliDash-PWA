import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import {
  cacheDrawing,
  enqueuePendingOp,
  getCachedDrawing,
  updateCachedDrawing,
  updateCachedDrawingSummary,
} from "../../db/offline-db";
import { getPersistedAppState, hasRenderableElements, haveSameElements } from "./shared";

type SaveFn = (
  drawingId: string,
  elements: readonly any[],
  appState: any,
  files?: Record<string, any>,
) => void;

type OfflineFlushRefs = {
  excalidrawAPI: MutableRefObject<any>;
  debouncedSave: MutableRefObject<SaveFn | null>;
  drawingName: MutableRefObject<string>;
  currentDrawingVersion: MutableRefObject<number | null>;
  latestAppState: MutableRefObject<any>;
  latestFiles: MutableRefObject<any>;
  latestElements: MutableRefObject<readonly any[]>;
  lastPersistedElements: MutableRefObject<readonly any[]>;
  hasSceneChangesSinceLoad: MutableRefObject<boolean>;
  suspiciousBlankLoad: MutableRefObject<boolean>;
  isUnmounting: MutableRefObject<boolean>;
};

type UseEditorOfflineFlushParams = {
  drawingId: string | undefined;
  canEdit: boolean;
  refs: OfflineFlushRefs;
  resolveSafeSnapshot: (candidateSnapshot?: readonly any[]) => {
    snapshot: readonly any[];
    prevented: boolean;
  };
  normalizeImageElementStatus: (
    elements?: readonly any[],
    files?: Record<string, any> | null,
  ) => readonly any[];
};

/**
 * Persists the live editor scene to IndexedDB the moment the PWA is hidden or
 * unloaded, so edits survive a user closing/backgrounding the app without
 * navigating back to the dashboard.
 *
 * Why this exists: the editor's autosave is a 1s debounce. On mobile PWAs,
 * timers are frozen when the app is backgrounded and discarded when it is
 * killed, so a pending debounced save never runs. Any edits made since the
 * last 1s-pause save would then be lost, and reopening (cache-first) shows
 * the stale partial version. This hook closes that gap by writing the current
 * scene to the local cache on `visibilitychange` (hidden), `pagehide`,
 * `beforeunload`, and `freeze` — before the JS runtime is suspended.
 *
 * The write is local-only (no network, which would be killed mid-flight).
 * When offline (or when changes never reached the server), a pending op is
 * enqueued so the OfflineContext pushes it to the server on the next
 * reconnect/launch.
 */
export const useEditorOfflineFlush = ({
  drawingId,
  canEdit,
  refs,
  resolveSafeSnapshot,
  normalizeImageElementStatus,
}: UseEditorOfflineFlushParams) => {
  // Keep the latest flush logic in a ref so the stable event listener always
  // reads fresh state (drawingId/canEdit/refs can change across renders).
  const flushRef = useRef<() => void>(() => {});

  // Update the latest-closure ref after every render (the canonical React
  // "latest event handler" pattern). This avoids rebinding listeners on every
  // render while ensuring the listener always sees current props/refs. Done in
  // an effect (not during render) to comply with react-hooks/refs.
  useEffect(() => {
    flushRef.current = () => {
      if (!drawingId || !canEdit) return;
      if (refs.isUnmounting.current) return;
      // Only flush when the user actually edited — avoids redundant writes when
      // the app is merely backgrounded without changes.
      if (!refs.hasSceneChangesSinceLoad.current) return;
      const exApi = refs.excalidrawAPI.current;
      let elements: readonly any[];
      let appState: any;
      let files: Record<string, any>;
      try {
        // Read the freshest scene directly from Excalidraw. On hide,
        // Excalidraw blurs the active text editor and commits it to the scene
        // first, so this captures in-progress text the debounced autosave
        // never saw.
        elements = exApi?.getSceneElementsIncludingDeleted?.() ?? refs.latestElements.current ?? [];
        appState = exApi?.getAppState?.() ?? refs.latestAppState.current ?? {};
        files = exApi?.getFiles?.() ?? refs.latestFiles.current ?? {};
      } catch {
        elements = refs.latestElements.current ?? [];
        appState = refs.latestAppState.current ?? {};
        files = refs.latestFiles.current ?? {};
      }

      const { snapshot: safeElements, prevented } = resolveSafeSnapshot(elements);
      if (prevented) return;
      // Protect existing data: never let a suspicious blank load overwrite a
      // previously non-empty drawing.
      if (refs.suspiciousBlankLoad.current && !hasRenderableElements(safeElements)) {
        return;
      }
      const normalized = normalizeImageElementStatus(safeElements, files);

      // Skip when nothing changed since the last successful persist. This
      // prevents redundant cache writes and — critically — redundant pending
      // ops (and their "synced" toasts) when the autosave already reached the
      // server/cache. When the scene differs, we enqueue so a killed-online
      // session still syncs on next launch.
      if (haveSameElements(normalized, refs.lastPersistedElements.current)) {
        return;
      }

      const persistableAppState = getPersistedAppState(appState);
      const currentName = refs.drawingName.current || "Untitled Drawing";
      const version = refs.currentDrawingVersion.current ?? 1;
      // Capture the baseline ref into a local before mutating it inside the
      // async closure — mutating a local's `.current` keeps the
      // react-hooks/immutability lint rule happy (mutating the `refs` argument
      // object directly is disallowed).
      const lastPersistedElementsRef = refs.lastPersistedElements;

      // Fire-and-forget: must not block pagehide/beforeunload. IndexedDB
      // transactions initiated here complete even as the page tears down.
      void (async () => {
        try {
          // Merge into an existing cached drawing to preserve the preview
          // thumbnail; only fall back to a full put when nothing is cached yet
          // (rare — the editor caches on load, so a record usually exists).
          const existing = await getCachedDrawing(drawingId).catch(() => undefined);
          if (existing) {
            await updateCachedDrawing(drawingId, {
              name: currentName,
              elements: Array.from(normalized),
              appState: persistableAppState,
              files: files || null,
              ...(typeof version === "number" ? { version } : {}),
            });
          } else {
            await cacheDrawing({
              id: drawingId,
              name: currentName,
              collectionId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              version,
              elements: Array.from(normalized),
              appState: persistableAppState,
              files: files || null,
              preview: null,
            });
          }
          await updateCachedDrawingSummary(drawingId, {
            name: currentName,
            updatedAt: Date.now(),
            ...(typeof version === "number" ? { version } : {}),
          });
          // Update the snapshot-guard baseline so a later transient empty
          // onChange can't overwrite the scene we just protected.
          lastPersistedElementsRef.current = normalized;
          // Enqueue a pending op whenever the server may not have these
          // changes yet (offline, or the autosave was killed mid-debounce).
          // coalescePendingOps collapses multiple flushes into the latest
          // snapshot, and the sync layer reconciles any cross-device conflict.
          await enqueuePendingOp({
            drawingId,
            type: "update",
            payload: {
              name: currentName,
              elements: Array.from(normalized),
              appState: persistableAppState,
              ...(Object.keys(files || {}).length > 0 ? { files } : {}),
            },
          });
        } catch (err) {
          console.warn("[Editor] Offline flush failed", err);
        }
      })();
    };
  });

  useEffect(() => {
    if (!drawingId || !canEdit) return;
    const flush = () => {
      flushRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    // `visibilitychange`→hidden is the primary trigger on mobile: it fires
    // before the runtime is suspended, giving Excalidraw a chance to commit
    // in-progress text and us a chance to write it to the cache.
    document.addEventListener("visibilitychange", onVisibility);
    // `pagehide`/`beforeunload` cover the actual close/kill. `pagehide` is
    // preferred over `beforeunload` (deprecated on mobile and unreliable).
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    // `freeze` (Page Lifecycle API) covers OS-level background eviction.
    window.addEventListener("freeze", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("freeze", flush);
    };
  }, [drawingId, canEdit]);
};
