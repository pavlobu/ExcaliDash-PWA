import { useEffect, useRef } from "react";
import { isAutoLockOnOpenEnabled } from "../../utils/editorPreferences";

type UseEditorAutoLockParams = {
  drawingId: string | undefined;
  isReady: boolean;
  canEdit: boolean;
  setIsLocked: (locked: boolean) => void;
};

/**
 * Auto-locks the drawing (read-only canvas) when an existing drawing is
 * opened, so the canvas opens frozen — no accidental moves, especially
 * useful on touch devices. Gated by the "Auto-lock drawings on open"
 * preference (default on). The lock is a session-level viewMode toggle:
 * the user unlocks via the header lock button to edit.
 */
export const useEditorAutoLock = ({
  drawingId,
  isReady,
  canEdit,
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

    if (isAutoLockOnOpenEnabled()) {
      setIsLocked(true);
    }
  }, [drawingId, isReady, canEdit, setIsLocked]);
};
