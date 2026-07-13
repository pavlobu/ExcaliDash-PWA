import { useCallback } from "react";
import type { MutableRefObject } from "react";
import {
  buildRichTextElementPatch,
  EMPTY_RICH_TEXT_DOC,
  RICH_TEXT_WIDGET_MARKER,
} from "./shared";

// Mirrors `CaptureUpdateAction.IMMEDIATELY` from @excalidraw/excalidraw. Kept
// as a local string so this module doesn't pull the full Excalidraw UI bundle
// into jsdom-based unit tests (see shared.ts for the same pattern).
const CAPTURE_UPDATE_IMMEDIATELY = "IMMEDIATELY" as const;

type UseRichTextWidgetActionsParams = {
  canEdit: boolean;
  excalidrawAPI: MutableRefObject<any>;
  theme: string;
};

/**
 * Actions for the standalone "Rich Text" widget (an Excalidraw rectangle
 * host carrying Tiptap JSON in `customData.richText`). Commit patches the host
 * element with the new JSON + a plain-text mirror; insert drops a new
 * theme-aware card-sized rectangle at the viewport center and selects it.
 */
export const useRichTextWidgetActions = ({
  canEdit,
  excalidrawAPI,
  theme,
}: UseRichTextWidgetActionsParams) => {
  const handleRichTextCommit = useCallback(
    (elementId: string, json: unknown, plainText: string) => {
      const exApi = excalidrawAPI.current;
      if (!exApi || !canEdit) return;
      exApi.updateScene({
        elements: (elements: readonly any[]) =>
          elements.map((el: any) =>
            el && el.id === elementId
              ? { ...el, ...buildRichTextElementPatch(el, json, plainText) }
              : el,
          ),
      });
    },
    [canEdit, excalidrawAPI],
  );

  const handleInsertRichTextWidget = useCallback(() => {
    const exApi = excalidrawAPI.current;
    if (!exApi || !canEdit) return;
    const appState = exApi.getAppState?.();
    if (!appState) return;
    const zoom = appState.zoom?.value ?? 1;
    const w = 320 / zoom;
    const h = 160 / zoom;
    const cx = (appState.width / 2 - (appState.scrollX ?? 0)) / zoom;
    const cy = (appState.height / 2 - (appState.scrollY ?? 0)) / zoom;
    const isDark = theme === "dark";
    exApi.updateScene({
      elements: [
        ...exApi.getSceneElementsIncludingDeleted(),
        {
          type: "rectangle",
          x: cx - w / 2,
          y: cy - h / 2,
          width: w,
          height: h,
          strokeColor: "#6366f1",
          backgroundColor: isDark ? "#1e1b3a" : "#f5f3ff",
          fillStyle: "solid",
          strokeWidth: 2,
          strokeStyle: "solid",
          roughness: 0,
          opacity: 100,
          angle: 0,
          groupIds: [],
          frameId: null,
          roundness: { type: 3 },
          locked: false,
          customData: {
            [RICH_TEXT_WIDGET_MARKER]: true,
            richText: EMPTY_RICH_TEXT_DOC,
          },
        },
      ] as any,
      appState: { selectedElementIds: {} },
      captureUpdate: CAPTURE_UPDATE_IMMEDIATELY,
    });
  }, [canEdit, excalidrawAPI, theme]);

  return { handleRichTextCommit, handleInsertRichTextWidget };
};
