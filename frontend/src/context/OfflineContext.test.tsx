import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as offline from "../db/offline-db";
import { OfflineProvider, useOffline } from "./OfflineContext";
import type { PendingOp } from "../db/offline-db";

vi.mock("../api", () => ({
  createDrawing: vi.fn(),
  updateDrawing: vi.fn(),
  deleteDrawing: vi.fn(),
  getDrawing: vi.fn(),
  isAxiosError: vi.fn(() => false),
}));

vi.mock("../db/offline-db", () => ({
  getPendingOps: vi.fn(),
  removePendingOp: vi.fn(),
  incrementOpAttempts: vi.fn(),
  hasPendingOps: vi.fn(),
  getCachedDrawing: vi.fn(),
  cacheDrawing: vi.fn(),
  cacheDrawingSummary: vi.fn(),
  updateCachedDrawing: vi.fn(),
  updateCachedDrawingSummary: vi.fn(),
  removeCachedDrawing: vi.fn(),
  removeCachedCollection: vi.fn(),
  getIdMapping: vi.fn(),
  setIdMapping: vi.fn(),
  clearIdMappings: vi.fn(),
}));

const Probe = () => {
  const { isSyncing, pendingCount } = useOffline();
  return (
    <div>
      <span data-testid="syncing">{String(isSyncing)}</span>
      <span data-testid="pending">{String(pendingCount)}</span>
    </div>
  );
};

const makeOp = (overrides: Partial<PendingOp>): PendingOp => ({
  id: overrides.id ?? "op-" + Math.random(),
  drawingId: overrides.drawingId ?? "L1",
  type: overrides.type ?? "create",
  payload: overrides.payload ?? null,
  createdAt: overrides.createdAt ?? Date.now(),
  attempts: 0,
});

describe("OfflineProvider sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore spies (e.g., navigator.onLine) so they don't leak into
    // other test files sharing the same jsdom environment.
    vi.restoreAllMocks();
  });

  it("drains a create op and remaps a following update op to the server id", async () => {
    const createOp = makeOp({
      id: "op-create",
      drawingId: "L1",
      type: "create",
      payload: { name: "Untitled Drawing", collectionId: null },
      createdAt: 1,
    });
    const updateOp = makeOp({
      id: "op-update",
      drawingId: "L1",
      type: "update",
      payload: { elements: [{ id: "e1" }] },
      createdAt: 2,
    });

    // hasPendingOps=false keeps refreshPendingCount from consuming the ops
    // queue before triggerSync drains it.
    vi.mocked(offline.hasPendingOps).mockResolvedValue(false);
    vi.mocked(offline.getPendingOps).mockResolvedValue([createOp, updateOp]);
    vi.mocked(offline.getCachedDrawing).mockResolvedValue({
      id: "L1",
      name: "Untitled Drawing",
      collectionId: null,
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      preview: null,
      elements: [{ id: "e1" }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: null,
    } as any);
    vi.mocked(api.createDrawing).mockResolvedValue({ id: "S1" });
    vi.mocked(api.updateDrawing).mockResolvedValue({} as any);
    vi.mocked(offline.getIdMapping).mockResolvedValue(undefined);
    vi.mocked(offline.setIdMapping).mockResolvedValue(undefined);
    vi.mocked(offline.removeCachedDrawing).mockResolvedValue(undefined);
    vi.mocked(offline.cacheDrawingSummary).mockResolvedValue(undefined);
    vi.mocked(offline.removePendingOp).mockResolvedValue(undefined);
    vi.mocked(offline.clearIdMappings).mockResolvedValue(undefined);

    const syncListener = vi.fn();
    window.addEventListener("excalidash:offline-sync", syncListener);

    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>
    );

    await waitFor(() => {
      expect(vi.mocked(api.createDrawing)).toHaveBeenCalledWith("Untitled Drawing", null);
    });

    await waitFor(() => {
      expect(vi.mocked(api.updateDrawing)).toHaveBeenCalledWith(
        "S1",
        expect.objectContaining({ elements: [{ id: "e1" }] }),
      );
    });

    // The create op must persist the local→server mapping and drop the local cache.
    expect(vi.mocked(offline.setIdMapping)).toHaveBeenCalledWith("L1", "S1");
    expect(vi.mocked(offline.removeCachedDrawing)).toHaveBeenCalledWith("L1");

    // The following update op must target the remapped server id (S1), not L1.
    const updateCalls = vi.mocked(api.updateDrawing).mock.calls;
    expect(updateCalls.some(([id]) => id === "S1")).toBe(true);
    expect(updateCalls.some(([id]) => id === "L1")).toBe(false);

    await waitFor(() => {
      expect(syncListener).toHaveBeenCalled();
    });

    window.removeEventListener("excalidash:offline-sync", syncListener);
  });

  it("remaps an update op via a persisted mapping from a previous sync run", async () => {
    const updateOp = makeOp({
      id: "op-update-2",
      drawingId: "L2",
      type: "update",
      payload: { elements: [{ id: "e2" }] },
      createdAt: 3,
    });

    vi.mocked(offline.hasPendingOps).mockResolvedValue(false);
    vi.mocked(offline.getPendingOps).mockResolvedValue([updateOp]);
    vi.mocked(offline.getCachedDrawing).mockResolvedValue(undefined);
    vi.mocked(offline.getIdMapping).mockResolvedValue("S2");
    vi.mocked(api.updateDrawing).mockResolvedValue({} as any);
    vi.mocked(offline.removePendingOp).mockResolvedValue(undefined);
    vi.mocked(offline.clearIdMappings).mockResolvedValue(undefined);

    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>
    );

    await waitFor(() => {
      expect(vi.mocked(api.updateDrawing)).toHaveBeenCalledWith(
        "S2",
        expect.objectContaining({ elements: [{ id: "e2" }] }),
      );
    });

    expect(vi.mocked(offline.removePendingOp)).toHaveBeenCalledWith("op-update-2");
  });

  it("does not sync while offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(offline.hasPendingOps).mockResolvedValue(false);
    vi.mocked(offline.getPendingOps).mockResolvedValue([]);

    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(api.createDrawing)).not.toHaveBeenCalled();
  });

  it("coalesces multiple update ops for one drawing into a single server write", async () => {
    // Simulates offline autosave enqueueing N update ops for one drawing.
    // Before the fix, op1 bumped the server version and op2 409'd -> the loop
    // broke and dropped op2..opN. Now they collapse into one op.
    const u1 = makeOp({ id: "u1", drawingId: "D1", type: "update", payload: { elements: [{ id: "e1" }] }, createdAt: 1 });
    const u2 = makeOp({ id: "u2", drawingId: "D1", type: "update", payload: { elements: [{ id: "e2" }] }, createdAt: 2 });
    const u3 = makeOp({ id: "u3", drawingId: "D1", type: "update", payload: { name: "renamed", elements: [{ id: "e3" }] }, createdAt: 3 });

    vi.mocked(offline.hasPendingOps).mockResolvedValue(false);
    vi.mocked(offline.getPendingOps).mockResolvedValue([u1, u2, u3]);
    vi.mocked(offline.getCachedDrawing).mockResolvedValue({
      id: "D1", name: "renamed", collectionId: null, createdAt: 1, updatedAt: 3,
      version: 5, preview: null, elements: [{ id: "e3" }], appState: {}, files: null,
    } as any);
    vi.mocked(api.updateDrawing).mockResolvedValue({ id: "D1", version: 6 } as any);
    vi.mocked(offline.getIdMapping).mockResolvedValue(undefined);
    vi.mocked(offline.removePendingOp).mockResolvedValue(undefined);
    vi.mocked(offline.updateCachedDrawing).mockResolvedValue(undefined);
    vi.mocked(offline.updateCachedDrawingSummary).mockResolvedValue(undefined);
    vi.mocked(offline.clearIdMappings).mockResolvedValue(undefined);

    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>
    );

    // Exactly one server write, carrying the latest snapshot + name.
    await waitFor(() => {
      expect(vi.mocked(api.updateDrawing)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(api.updateDrawing)).toHaveBeenCalledWith(
      "D1",
      expect.objectContaining({ name: "renamed", elements: [{ id: "e3" }], version: 5 }),
    );

    // All three source ops are purged (two coalesced + one processed).
    await waitFor(() => {
      expect(vi.mocked(offline.removePendingOp)).toHaveBeenCalledTimes(3);
    });
  });

  it("continues syncing unrelated drawings after one op fails (no break)", async () => {
    const a = makeOp({ id: "a", drawingId: "DA", type: "update", payload: { elements: [{ id: "ea" }] }, createdAt: 1 });
    const b = makeOp({ id: "b", drawingId: "DB", type: "update", payload: { elements: [{ id: "eb" }] }, createdAt: 2 });

    vi.mocked(offline.hasPendingOps).mockResolvedValue(false);
    vi.mocked(offline.getPendingOps).mockResolvedValue([a, b]);
    vi.mocked(offline.getCachedDrawing).mockResolvedValue(undefined);
    vi.mocked(offline.getIdMapping).mockResolvedValue(undefined);
    // First call (DA) fails, second (DB) succeeds.
    vi.mocked(api.updateDrawing)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "DB", version: 2 } as any);
    vi.mocked(api.isAxiosError).mockReturnValue(false);
    vi.mocked(offline.incrementOpAttempts).mockResolvedValue(undefined);
    vi.mocked(offline.removePendingOp).mockResolvedValue(undefined);
    vi.mocked(offline.updateCachedDrawing).mockResolvedValue(undefined);
    vi.mocked(offline.updateCachedDrawingSummary).mockResolvedValue(undefined);
    vi.mocked(offline.clearIdMappings).mockResolvedValue(undefined);

    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>
    );

    // DB must still be pushed even though DA failed.
    await waitFor(() => {
      expect(vi.mocked(api.updateDrawing)).toHaveBeenCalledWith(
        "DB",
        expect.objectContaining({ elements: [{ id: "eb" }] }),
      );
    });
    await waitFor(() => {
      expect(vi.mocked(offline.removePendingOp)).toHaveBeenCalledWith("b");
    });
    // DA's failure is recorded (attempts incremented) and it is NOT removed.
    expect(vi.mocked(offline.incrementOpAttempts)).toHaveBeenCalledWith("a");
    expect(vi.mocked(offline.removePendingOp)).not.toHaveBeenCalledWith("a");
  });

  it("retries once on 409 with a fresh version instead of dropping the edit", async () => {
    const op = makeOp({ id: "op409", drawingId: "D9", type: "update", payload: { elements: [{ id: "e9" }] }, createdAt: 1 });

    vi.mocked(offline.hasPendingOps).mockResolvedValue(false);
    vi.mocked(offline.getPendingOps).mockResolvedValue([op]);
    vi.mocked(offline.getCachedDrawing).mockResolvedValue({
      id: "D9", name: "n", collectionId: null, createdAt: 1, updatedAt: 1,
      version: 4, preview: null, elements: [{ id: "e9" }], appState: {}, files: null,
    } as any);
    const conflict = { isAxiosError: true, response: { status: 409, data: { currentVersion: 7 } } };
    vi.mocked(api.isAxiosError).mockReturnValue(true);
    vi.mocked(api.updateDrawing)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: "D9", version: 8 } as any);
    vi.mocked(api.getDrawing).mockResolvedValue({ id: "D9", version: 7 } as any);
    vi.mocked(offline.cacheDrawing).mockResolvedValue(undefined);
    vi.mocked(offline.getIdMapping).mockResolvedValue(undefined);
    vi.mocked(offline.removePendingOp).mockResolvedValue(undefined);
    vi.mocked(offline.updateCachedDrawing).mockResolvedValue(undefined);
    vi.mocked(offline.updateCachedDrawingSummary).mockResolvedValue(undefined);
    vi.mocked(offline.clearIdMappings).mockResolvedValue(undefined);

    render(
      <OfflineProvider>
        <Probe />
      </OfflineProvider>
    );

    // Fresh version fetched, then retried with version 7.
    await waitFor(() => {
      expect(vi.mocked(api.getDrawing)).toHaveBeenCalledWith("D9");
    });
    await waitFor(() => {
      expect(vi.mocked(api.updateDrawing)).toHaveBeenCalledWith(
        "D9",
        expect.objectContaining({ version: 7, elements: [{ id: "e9" }] }),
      );
    });
    await waitFor(() => {
      expect(vi.mocked(offline.removePendingOp)).toHaveBeenCalledWith("op409");
    });
  });
});
