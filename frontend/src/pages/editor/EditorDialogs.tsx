import React from "react";
import type { MutableRefObject } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { ShareModal } from "../../components/ShareModal";
import { HistoryPanel } from "../../components/HistoryPanel";
import { getPersistedAppState } from "./shared";

type PreviewBackup = {
  elements: readonly any[];
  appState: any;
  files: any;
};

type EditorDialogsProps = {
  drawingId?: string;
  drawingName: string;
  excalidrawAPIRef: React.MutableRefObject<any>;
  isSyncingRef: MutableRefObject<boolean>;
  isHistoryOpen: boolean;
  isShareOpen: boolean;
  previewBackupRef: React.MutableRefObject<PreviewBackup | null>;
  onCloseHistory: () => void;
  onCloseShare: () => void;
};

export const EditorDialogs: React.FC<EditorDialogsProps> = ({
  drawingId,
  drawingName,
  excalidrawAPIRef,
  isSyncingRef,
  isHistoryOpen,
  isShareOpen,
  previewBackupRef,
  onCloseHistory,
  onCloseShare,
}) => {
  if (!drawingId) return null;

  return (
    <>
      <ShareModal
        drawingId={drawingId}
        drawingName={drawingName}
        isOpen={isShareOpen}
        onClose={onCloseShare}
      />
      <HistoryPanel
        drawingId={drawingId}
        isOpen={isHistoryOpen}
        onClose={onCloseHistory}
        onPreview={(snapshot) => {
          const excalidrawAPI = excalidrawAPIRef.current;
          if (!excalidrawAPI) return;
          // Guard: set isSyncing so the onChange handler
          // (useEditorCanvasHandlers) skips this as a user edit. Without
          // this, the preview's updateScene triggers onChange →
          // broadcastChanges → debouncedSave, which would overwrite the
          // current drawing with the previewed (old) snapshot state.
          // Reset on the next tick to catch async onChange emissions.
          isSyncingRef.current = true;
          if (snapshot) {
            if (!previewBackupRef.current) {
              previewBackupRef.current = {
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                appState: excalidrawAPI.getAppState(),
                files: excalidrawAPI.getFiles(),
              };
            }
            const elements = Array.isArray(snapshot.elements)
              ? snapshot.elements
              : [];
            const files = snapshot.files || {};
            if (Object.keys(files).length > 0) {
              excalidrawAPI.addFiles(Object.values(files));
            }
            // Use only scene-relevant appState fields (background color,
            // grid) from the snapshot — spreading the full stored appState
            // (which includes transient viewport/selection state like
            // scrollX, scrollY, zoom, selectedElementIds) corrupts the
            // user's current view and can break the Excalidraw UI.
            excalidrawAPI.updateScene({
              elements,
              appState: {
                ...getPersistedAppState(snapshot.appState),
                collaborators: new Map(),
              },
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            setTimeout(() => {
              isSyncingRef.current = false;
            }, 0);
            return;
          }
          if (previewBackupRef.current) {
            excalidrawAPI.updateScene({
              elements: previewBackupRef.current.elements as any[],
              appState: {
                ...getPersistedAppState(previewBackupRef.current.appState),
                collaborators: new Map(),
              },
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            if (previewBackupRef.current.files) {
              excalidrawAPI.addFiles(
                Object.values(previewBackupRef.current.files),
              );
            }
            previewBackupRef.current = null;
          }
          setTimeout(() => {
            isSyncingRef.current = false;
          }, 0);
        }}
        onRestore={() => {
          previewBackupRef.current = null;
          window.location.reload();
        }}
      />
    </>
  );
};
