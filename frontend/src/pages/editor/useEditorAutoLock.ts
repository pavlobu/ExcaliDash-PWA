import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import { isAutoLockOnOpenEnabled } from "../../utils/editorPreferences";
import { hasRenderableElements } from "./shared";

type UseEditorAutoLockParams = {
  drawingId: string | undefined;
  isReady: boolean;
  canEdit: boolean;
  initialSceneElementsRef: MutableRefObject<readonly any[]>;
  setIsLocked: (locked: boolean) => void;
};

/**
 * Auto-locks the drawing (read-only canvas) when an existing drawing with
 * content is opened, so the canvas opens frozen — no accidental moves,
 * especially useful on touch devices. Gated by the "Auto-lock drawings on
 * open" preference (default on). The lock is a session-level viewMode
 * toggle: the user unlocks via the header lock button to edit.
 *
 * Empty/new drawings are never auto-locked — there is nothing on the
 * canvas to protect, and locking an empty canvas only blocks the first
 * stroke.
 */
export const useEditorAutoLock = ({
  drawingId,
  isReady,
  canEdit,
  initialSceneElementsRef,
  setIsLocked,
}: UseEditorAutoLockParams) => {
  const appliedForRef = useRef<string | null>(null);

  // Reset the one-shot guard when the drawing changes so re-opening the
  // same drawing (A -> back -> A) re-applies the autolock.
  useEffect(() => {
    if (appliedForRef.current !== drawingId) {
      appliedForRef.current = null;
    }
  }, [drawingId]);

  useEffect(() => {
    if (!drawingId || !isReady || !canEdit) return;
    if (appliedForRef.current === drawingId) return;
    appliedForRef.current = drawingId;

    if (!isAutoLockOnOpenEnabled()) return;

    // Skip empty/new drawings: nothing on the canvas to protect.
    if (!hasRenderableElements(initialSceneElementsRef.current)) return;

    setIsLocked(true);
    toast.info(
      "Drawing locked to prevent accidental edits. Toggle the lock icon in the top panel to unlock.",
    );
  }, [drawingId, isReady, canEdit, initialSceneElementsRef, setIsLocked]);
};
