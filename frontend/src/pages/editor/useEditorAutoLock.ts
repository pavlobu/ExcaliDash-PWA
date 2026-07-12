import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { isAutoLockOnOpenEnabled } from "../../utils/editorPreferences";
import { hasRenderableElements } from "./shared";

type UseEditorAutoLockParams = {
  drawingId: string | undefined;
  excalidrawAPI: MutableRefObject<any>;
  isReady: boolean;
  isSceneHydrated: boolean;
  canEdit: boolean;
  setIsLocked: (locked: boolean) => void;
};

/**
 * Auto-locks every renderable element when an existing drawing is opened,
 * so the canvas opens in a frozen (no-accidental-move) state — especially
 * useful on touch devices. Gated by the "Auto-lock drawings on open"
 * preference (default on). Applied once per drawing after the scene
 * hydrates; the resulting `locked` change flows through the normal
 * onChange -> broadcast -> save path so it persists.
 */
export const useEditorAutoLock = ({
  drawingId,
  excalidrawAPI,
  isReady,
  isSceneHydrated,
  canEdit,
  setIsLocked,
}: UseEditorAutoLockParams) => {
  const appliedForRef = useRef<string | null>(null);

  // Reset the one-shot guard when the drawing changes so re-opening the
  // same drawing (A -> back -> A) re-applies the autolock. Without this
  // the ref keeps the previous id and the guard short-circuits.
  useEffect(() => {
    if (appliedForRef.current !== drawingId) {
      appliedForRef.current = null;
    }
  }, [drawingId]);

  useEffect(() => {
    if (!drawingId || !isReady || !canEdit || !isSceneHydrated) return;
    if (appliedForRef.current === drawingId) return;
    appliedForRef.current = drawingId;

    const api = excalidrawAPI.current;
    if (!api || typeof api.getSceneElementsIncludingDeleted !== "function") return;

    if (!isAutoLockOnOpenEnabled()) return;

    const elements = api.getSceneElementsIncludingDeleted() ?? [];
    if (!hasRenderableElements(elements)) return;

    const allLocked = elements.every(
      (el: any) => el?.isDeleted === true || el?.locked === true,
    );
    if (allLocked) {
      setIsLocked(true);
      return;
    }

    const lockedElements = elements.map((el: any) =>
      el?.isDeleted === true ? el : { ...el, locked: true },
    );
    api.updateScene({
      elements: lockedElements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setIsLocked(true);
  }, [
    drawingId,
    isReady,
    isSceneHydrated,
    canEdit,
    excalidrawAPI,
    setIsLocked,
  ]);
};
