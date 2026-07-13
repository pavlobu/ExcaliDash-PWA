import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRichTextWidgetActions } from "./useRichTextWidgetActions";
import { RICH_TEXT_WIDGET_MARKER } from "./shared";

const makeApi = (overrides: Record<string, any> = {}) => {
  const elements: any[] = [];
  const appState = {
    width: 1000,
    height: 800,
    scrollX: 0,
    scrollY: 0,
    zoom: { value: 1 },
    selectedElementIds: {},
    ...overrides,
  };
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    updateScene: vi.fn((opts: any) => {
      if (Array.isArray(opts.elements)) {
        elements.length = 0;
        elements.push(...opts.elements);
      }
      if (opts.appState) Object.assign(appState, opts.appState);
    }),
  };
  return { api, elements, appState };
};

describe("useRichTextWidgetActions", () => {
  it("handleInsertRichTextWidget creates a marked rectangle at the viewport center", () => {
    const { api, elements } = makeApi();
    const { result } = renderHook(() =>
      useRichTextWidgetActions({
        canEdit: true,
        excalidrawAPI: { current: api },
        theme: "light",
      }),
    );
    act(() => result.current.handleInsertRichTextWidget());
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect(elements.length).toBe(1);
    const el = elements[0];
    expect(el.type).toBe("rectangle");
    expect(el.customData[RICH_TEXT_WIDGET_MARKER]).toBe(true);
    expect(el.customData.richText.type).toBe("doc");
    // Centered at (500, 400) with default 320x160.
    expect(el.x).toBe(500 - 160);
    expect(el.y).toBe(400 - 80);
    expect(el.width).toBe(320);
    expect(el.height).toBe(160);
    // Light theme fill + indigo border.
    expect(el.backgroundColor).toBe("#f5f3ff");
    expect(el.strokeColor).toBe("#6366f1");
    expect(el.strokeWidth).toBe(2);
    expect(el.strokeStyle).toBe("solid");
  });

  it("uses dark theme colors when theme is dark", () => {
    const { api, elements } = makeApi();
    const { result } = renderHook(() =>
      useRichTextWidgetActions({
        canEdit: true,
        excalidrawAPI: { current: api },
        theme: "dark",
      }),
    );
    act(() => result.current.handleInsertRichTextWidget());
    expect(elements[0].backgroundColor).toBe("#1e1b3a");
    expect(elements[0].strokeColor).toBe("#6366f1");
  });

  it("no-ops when canEdit is false", () => {
    const { api } = makeApi();
    const { result } = renderHook(() =>
      useRichTextWidgetActions({
        canEdit: false,
        excalidrawAPI: { current: api },
        theme: "light",
      }),
    );
    act(() => result.current.handleInsertRichTextWidget());
    expect(api.updateScene).not.toHaveBeenCalled();
  });

  it("handleRichTextCommit patches the matching element's customData.richText + text and bumps version", () => {
    const { api, elements } = makeApi();
    // Seed an existing widget element.
    elements.push({
      id: "w1",
      type: "rectangle",
      text: undefined,
      version: 5,
      versionNonce: 1,
      customData: { [RICH_TEXT_WIDGET_MARKER]: true, richText: { type: "doc", content: [] } },
    });
    const { result } = renderHook(() =>
      useRichTextWidgetActions({
        canEdit: true,
        excalidrawAPI: { current: api },
        theme: "light",
      }),
    );
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "bold" }] }] }],
    };
    act(() => result.current.handleRichTextCommit("w1", doc, "hi"));
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    const patched = (api.updateScene.mock.calls[0][0].elements as any)([
      { id: "other", type: "rectangle" },
      ...elements,
    ]);
    const w1 = patched.find((e: any) => e.id === "w1");
    expect(w1.text).toBe("hi");
    expect(w1.customData.richText).toEqual(doc);
    expect(w1.version).toBe(6);
    expect(w1.versionNonce).not.toBe(1);
  });

  it("handleRichTextCommit preserves existing customData keys", () => {
    const { api, elements } = makeApi();
    elements.push({
      id: "w2",
      type: "rectangle",
      version: 1,
      versionNonce: 1,
      customData: { [RICH_TEXT_WIDGET_MARKER]: true, richText: null, note: "keep me" },
    });
    const { result } = renderHook(() =>
      useRichTextWidgetActions({
        canEdit: true,
        excalidrawAPI: { current: api },
        theme: "light",
      }),
    );
    act(() => result.current.handleRichTextCommit("w2", { type: "doc", content: [] }, ""));
    const patched = (api.updateScene.mock.calls[0][0].elements as any)(elements);
    const w2 = patched.find((e: any) => e.id === "w2");
    expect(w2.customData.note).toBe("keep me");
    expect(w2.customData[RICH_TEXT_WIDGET_MARKER]).toBe(true);
  });
});
