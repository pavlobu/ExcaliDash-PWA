import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorOfflineFlush } from "./useEditorOfflineFlush";

vi.mock("../../db/offline-db", () => ({
  cacheDrawing: vi.fn(() => Promise.resolve()),
  enqueuePendingOp: vi.fn(() => Promise.resolve({ id: "op-1" })),
  getCachedDrawing: vi.fn(() => Promise.resolve(undefined)),
  updateCachedDrawing: vi.fn(() => Promise.resolve()),
  updateCachedDrawingSummary: vi.fn(() => Promise.resolve()),
}));

import {
  cacheDrawing,
  enqueuePendingOp,
  getCachedDrawing,
  updateCachedDrawing,
  updateCachedDrawingSummary,
} from "../../db/offline-db";

const makeElement = (id: string, version = 1, text = "hello") => ({
  id,
  type: "text",
  text,
  version,
  versionNonce: 1,
  updated: 1,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  angle: 0,
  isDeleted: false,
});

const passthroughSnapshot = (candidate: readonly any[] = []) => ({
  snapshot: candidate,
  prevented: false,
});

const passthroughNormalize = (elements: readonly any[] = []) => elements;

const makeRefs = (overrides: Record<string, any> = {}) => ({
  excalidrawAPI: { current: null },
  debouncedSave: { current: null },
  drawingName: { current: "My Note" },
  currentDrawingVersion: { current: 5 },
  latestAppState: { current: { viewBackgroundColor: "#ffffff" } },
  latestFiles: { current: {} },
  latestElements: { current: [] },
  lastPersistedElements: { current: [] },
  hasSceneChangesSinceLoad: { current: true },
  suspiciousBlankLoad: { current: false },
  isUnmounting: { current: false },
  ...overrides,
});

const makeExcalidrawAPI = (
  elements: any[],
  appState: any = {},
  files: Record<string, any> = {},
) => ({
  getSceneElementsIncludingDeleted: () => elements,
  getAppState: () => appState,
  getFiles: () => files,
});

const setHidden = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

const waitForFlush = () =>
  act(async () => {
    // Drain the fire-and-forget async IIFE in the flush.
    await new Promise((r) => setTimeout(r, 0));
  });

describe("useEditorOfflineFlush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes the live scene to IndexedDB when the app is hidden", async () => {
    const element = makeElement("a1", 2, "long note body");
    const refs = makeRefs({
      excalidrawAPI: { current: makeExcalidrawAPI([element]) },
      latestElements: { current: [element] },
      lastPersistedElements: { current: [] },
    });

    renderHook(() =>
      useEditorOfflineFlush({
        drawingId: "d1",
        canEdit: true,
        refs,
        resolveSafeSnapshot: passthroughSnapshot,
        normalizeImageElementStatus: passthroughNormalize,
      }),
    );

    setHidden("hidden");
    await waitForFlush();

    // No prior cache -> full put via cacheDrawing.
    expect(cacheDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1", elements: [element] }),
    );
    expect(updateCachedDrawingSummary).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ name: "My Note" }),
    );
    // Pending op enqueued so the change reaches the server on reconnect.
    expect(enqueuePendingOp).toHaveBeenCalledWith(
      expect.objectContaining({
        drawingId: "d1",
        type: "update",
        payload: expect.objectContaining({ elements: [element] }),
      }),
    );
    // Baseline updated so a later transient empty snapshot can't overwrite.
    expect(refs.lastPersistedElements.current).toEqual([element]);
  });

  it("merges into an existing cached drawing (preserving preview)", async () => {
    const element = makeElement("a1", 2, "edited");
    const refs = makeRefs({
      excalidrawAPI: { current: makeExcalidrawAPI([element]) },
      latestElements: { current: [element] },
      lastPersistedElements: { current: [] },
    });
    vi.mocked(getCachedDrawing).mockResolvedValueOnce({
      id: "d1",
      name: "old",
      preview: "<svg/>",
    } as any);

    renderHook(() =>
      useEditorOfflineFlush({
        drawingId: "d1",
        canEdit: true,
        refs,
        resolveSafeSnapshot: passthroughSnapshot,
        normalizeImageElementStatus: passthroughNormalize,
      }),
    );

    setHidden("hidden");
    await waitForFlush();

    expect(updateCachedDrawing).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ elements: [element] }),
    );
    // Full put not used when a cached record exists.
    expect(cacheDrawing).not.toHaveBeenCalled();
  });

  it("does not flush when there are no scene changes since load", async () => {
    const refs = makeRefs({
      excalidrawAPI: { current: makeExcalidrawAPI([makeElement("a1")]) },
      hasSceneChangesSinceLoad: { current: false },
    });

    renderHook(() =>
      useEditorOfflineFlush({
        drawingId: "d1",
        canEdit: true,
        refs,
        resolveSafeSnapshot: passthroughSnapshot,
        normalizeImageElementStatus: passthroughNormalize,
      }),
    );

    setHidden("hidden");
    await waitForFlush();

    expect(cacheDrawing).not.toHaveBeenCalled();
    expect(enqueuePendingOp).not.toHaveBeenCalled();
  });

  it("does not flush when the user cannot edit", async () => {
    const refs = makeRefs({
      excalidrawAPI: { current: makeExcalidrawAPI([makeElement("a1")]) },
    });

    renderHook(() =>
      useEditorOfflineFlush({
        drawingId: "d1",
        canEdit: false,
        refs,
        resolveSafeSnapshot: passthroughSnapshot,
        normalizeImageElementStatus: passthroughNormalize,
      }),
    );

    setHidden("hidden");
    await waitForFlush();

    expect(cacheDrawing).not.toHaveBeenCalled();
  });

  it("does not flush when the scene matches the last persisted snapshot", async () => {
    const element = makeElement("a1", 2, "same");
    const refs = makeRefs({
      excalidrawAPI: { current: makeExcalidrawAPI([element]) },
      latestElements: { current: [element] },
      lastPersistedElements: { current: [element] }, // identical -> no diff
    });

    renderHook(() =>
      useEditorOfflineFlush({
        drawingId: "d1",
        canEdit: true,
        refs,
        resolveSafeSnapshot: passthroughSnapshot,
        normalizeImageElementStatus: passthroughNormalize,
      }),
    );

    setHidden("hidden");
    await waitForFlush();

    expect(cacheDrawing).not.toHaveBeenCalled();
    expect(updateCachedDrawing).not.toHaveBeenCalled();
    expect(enqueuePendingOp).not.toHaveBeenCalled();
  });

  it("flushes on pagehide", async () => {
    const element = makeElement("a1", 3, "pagehide note");
    const refs = makeRefs({
      excalidrawAPI: { current: makeExcalidrawAPI([element]) },
      latestElements: { current: [element] },
      lastPersistedElements: { current: [] },
    });

    renderHook(() =>
      useEditorOfflineFlush({
        drawingId: "d1",
        canEdit: true,
        refs,
        resolveSafeSnapshot: passthroughSnapshot,
        normalizeImageElementStatus: passthroughNormalize,
      }),
    );

    window.dispatchEvent(new Event("pagehide"));
    await waitForFlush();

    expect(cacheDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ id: "d1", elements: [element] }),
    );
  });
});
