import React, { useMemo, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import * as api from "../../api";
import type { Collection, DrawingSummary } from "../../types";
import { toast } from "sonner";
import {
  cacheDrawing,
  cacheDrawingSummary,
  enqueuePendingOp,
  updateCachedDrawing,
  updateCachedDrawingSummary,
} from "../../db/offline-db";

type UseDashboardDrawingActionsParams = {
  drawings: DrawingSummary[];
  setDrawings: React.Dispatch<React.SetStateAction<DrawingSummary[]>>;
  collections: Collection[];
  selectedCollectionId: string | null | undefined;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTotalCount: React.Dispatch<React.SetStateAction<number>>;
  uploadFiles: (files: File[], collectionId: string | null) => Promise<void>;
  refreshData: () => void;
  navigate: NavigateFunction;
};

const showTemporaryViewerError = (
  message: string,
  setViewerActionError: React.Dispatch<React.SetStateAction<string | null>>,
) => {
  setViewerActionError(message);
  setTimeout(() => setViewerActionError(null), 3000);
};

export const useDashboardDrawingActions = ({
  drawings,
  setDrawings,
  collections,
  selectedCollectionId,
  selectedIds,
  setSelectedIds,
  setTotalCount,
  uploadFiles,
  refreshData,
  navigate,
}: UseDashboardDrawingActionsParams) => {
  const [drawingToDelete, setDrawingToDelete] = useState<string | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showImportError, setShowImportError] = useState<{
    isOpen: boolean;
    message: string;
  }>({ isOpen: false, message: "" });
  const [viewerActionError, setViewerActionError] = useState<string | null>(
    null,
  );
  const [potentialDragId, setPotentialDragId] = useState<string | null>(null);

  const isTrashView = selectedCollectionId === "trash";
  const isSharedView = selectedCollectionId === "shared";
  const currentCollection = collections.find(
    (collection) => collection.id === selectedCollectionId,
  );
  const isSharedCollection = !!(
    currentCollection && currentCollection.isOwner === false
  );

  const handleViewerActionError = (message: string) =>
    showTemporaryViewerError(message, setViewerActionError);

  const handleCreateDrawing = async () => {
    if (isTrashView || isSharedView) return;
    if (isSharedCollection && currentCollection?.sharedRole !== "edit") {
      handleViewerActionError("Viewers can't create new drawings");
      return;
    }
    const targetCollectionId =
      selectedCollectionId === undefined ? null : selectedCollectionId;
    try {
      const { id } = await api.createDrawing(
        "Untitled Drawing",
        targetCollectionId,
      );
      navigate(`/editor/${id}`);
    } catch (err) {
      const isNetworkError = api.isNetworkError(err);

      if (isNetworkError) {
        const localId = crypto.randomUUID();
        const now = Date.now();
        const offlineDrawing: DrawingSummary = {
          id: localId,
          name: "Untitled Drawing",
          collectionId: targetCollectionId,
          createdAt: now,
          updatedAt: now,
          version: 1,
          preview: null,
          accessLevel: "owner",
        };
        setDrawings((prev) => [offlineDrawing, ...prev]);
        setTotalCount((prev) => prev + 1);
        try {
          await cacheDrawing({
            ...offlineDrawing,
            elements: [],
            appState: { viewBackgroundColor: "#ffffff" },
            files: null,
          });
          await cacheDrawingSummary(offlineDrawing);
          await enqueuePendingOp({
            drawingId: localId,
            type: "create",
            payload: { name: "Untitled Drawing", collectionId: targetCollectionId },
          });
          toast.info("Offline: drawing created locally. Will sync when reconnected.");
        } catch (cacheErr) {
          console.error("Failed to cache offline drawing:", cacheErr);
        }
        navigate(`/editor/${localId}`);
        return;
      }

      console.error(err);
      toast.error("Failed to create drawing");
    }
  };

  const handleImportDrawings = async (files: FileList | null) => {
    if (!files || isTrashView || isSharedView) return;
    if (isSharedCollection && currentCollection?.sharedRole !== "edit") {
      handleViewerActionError("Viewers can't import drawings");
      return;
    }
    const targetCollectionId =
      selectedCollectionId === undefined ? null : selectedCollectionId;
    uploadFiles(Array.from(files), targetCollectionId).finally(refreshData);
  };

  const handleRenameDrawing = async (id: string, name: string) => {
    // Capture the old name so we can revert on failure.
    const oldDrawing = drawings.find((d) => d.id === id);
    const oldName = oldDrawing?.name ?? name;
    setDrawings((current) =>
      current.map((drawing) =>
        drawing.id === id ? { ...drawing, name } : drawing,
      ),
    );
    // Optimistically update the IndexedDB cache BEFORE the API call.
    // If refreshData() fires while the API call is in flight (e.g.,
    // visibility change or prefetch event), it loads from cache —
    // without this update it would show the old name and overwrite
    // the optimistic UI state.
    updateCachedDrawing(id, { name }).catch(() => {});
    updateCachedDrawingSummary(id, { name }).catch(() => {});
    try {
      await api.updateDrawing(id, { name });
    } catch (err) {
      if (api.isNetworkError(err)) {
        try {
          await enqueuePendingOp({
            drawingId: id,
            type: "update",
            payload: { name },
          });
          toast.info("Offline: rename saved locally. Will sync when reconnected.");
        } catch (cacheErr) {
          console.error("Failed to cache offline rename:", cacheErr);
        }
        return;
      }
      console.error("Failed to rename drawing:", err);
      // Revert just this drawing instead of calling refreshData(),
      // which would re-fetch all drawings and clobber other UI state
      // (previews, selection, etc.).
      setDrawings((current) =>
        current.map((drawing) =>
          drawing.id === id ? { ...drawing, name: oldName } : drawing,
        ),
      );
      updateCachedDrawing(id, { name: oldName }).catch(() => {});
      updateCachedDrawingSummary(id, { name: oldName }).catch(() => {});
      toast.error("Failed to rename drawing");
    }
  };

  const moveOutOfCurrentView = (
    update: (drawing: DrawingSummary) => DrawingSummary,
    keep: (drawing: DrawingSummary) => boolean,
  ) => {
    setDrawings((current) => {
      const updated = current.map(update);
      const next = updated.filter(keep);
      setTotalCount((count) => count - (current.length - next.length));
      return next;
    });
  };

  const handleDeleteDrawing = async (id: string) => {
    if (isTrashView) {
      setDrawingToDelete(id);
      return;
    }
    setDrawings((current) => {
      const next = current.filter((drawing) => drawing.id !== id);
      if (next.length !== current.length) setTotalCount((count) => count - 1);
      return next;
    });
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    try {
      await api.updateDrawing(id, { collectionId: "trash" });
    } catch (err) {
      if (api.isNetworkError(err)) {
        try {
          await updateCachedDrawingSummary(id, { collectionId: "trash" });
          await enqueuePendingOp({
            drawingId: id,
            type: "update",
            payload: { collectionId: "trash" },
          });
        } catch (cacheErr) {
          console.error("Failed to cache offline trash move:", cacheErr);
        }
        return;
      }
      console.error("Failed to move to trash", err);
      refreshData();
    }
  };

  const executePermanentDelete = async (id: string) => {
    setDrawingToDelete(null);
    try {
      await api.deleteDrawing(id);
      setDrawings((current) => {
        const next = current.filter((drawing) => drawing.id !== id);
        if (next.length !== current.length) setTotalCount((count) => count - 1);
        return next;
      });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } catch (err) {
      console.error("Failed to delete drawing", err);
      refreshData();
    }
  };

  const executeBulkMoveToTrash = async () => {
    const ids = Array.from(selectedIds);
    setDrawings((current) => {
      const next = current.filter((drawing) => !selectedIds.has(drawing.id));
      setTotalCount((count) => count - (current.length - next.length));
      return next;
    });
    setSelectedIds(new Set());
    try {
      await Promise.all(
        ids.map((id) => api.updateDrawing(id, { collectionId: "trash" })),
      );
    } catch (err) {
      if (api.isNetworkError(err)) {
        try {
          await Promise.all(
            ids.map((id) =>
              Promise.all([
                updateCachedDrawingSummary(id, { collectionId: "trash" }),
                enqueuePendingOp({
                  drawingId: id,
                  type: "update",
                  payload: { collectionId: "trash" },
                }),
              ]),
            ),
          );
        } catch (cacheErr) {
          console.error("Failed to cache offline bulk trash:", cacheErr);
        }
        return;
      }
      console.error("Failed bulk move to trash", err);
      refreshData();
    }
  };

  const handleBulkDeleteClick = () => {
    if (selectedIds.size === 0) return;
    if (isTrashView) setShowBulkDeleteConfirm(true);
    else void executeBulkMoveToTrash();
  };

  const executeBulkPermanentDelete = async () => {
    const ids = Array.from(selectedIds);
    setShowBulkDeleteConfirm(false);
    try {
      await Promise.all(ids.map((id) => api.deleteDrawing(id)));
      const toDelete = new Set(ids);
      setDrawings((current) => {
        const next = current.filter((drawing) => !toDelete.has(drawing.id));
        setTotalCount((count) => count - (current.length - next.length));
        return next;
      });
      setSelectedIds(new Set());
    } catch (err) {
      console.error("Failed bulk delete", err);
      refreshData();
    }
  };

  const handleBulkMove = async (collectionId: string | null) => {
    if (selectedIds.size === 0) return;
    const idsToMove = Array.from(selectedIds);
    moveOutOfCurrentView(
      (drawing) =>
        selectedIds.has(drawing.id) ? { ...drawing, collectionId } : drawing,
      (drawing) => {
        if (selectedCollectionId === undefined) return true;
        if (selectedCollectionId === null) return drawing.collectionId === null;
        return drawing.collectionId === selectedCollectionId;
      },
    );
    setSelectedIds(new Set());
    try {
      await Promise.all(
        idsToMove.map((id) => api.updateDrawing(id, { collectionId })),
      );
    } catch (err) {
      if (api.isNetworkError(err)) {
        try {
          await Promise.all(
            idsToMove.map((id) =>
              Promise.all([
                updateCachedDrawingSummary(id, { collectionId }),
                enqueuePendingOp({
                  drawingId: id,
                  type: "update",
                  payload: { collectionId },
                }),
              ]),
            ),
          );
        } catch (cacheErr) {
          console.error("Failed to cache offline bulk move:", cacheErr);
        }
        return;
      }
      console.error("Failed bulk move", err);
      refreshData();
    }
  };

  const handleDuplicateDrawing = async (id: string) => {
    try {
      await api.duplicateDrawing(id);
      refreshData();
    } catch (err) {
      console.error("Failed to duplicate drawing:", err);
    }
  };

  const handleBulkDuplicate = async () => {
    if (selectedIds.size === 0) return;
    try {
      await Promise.all(
        Array.from(selectedIds).map((id) => api.duplicateDrawing(id)),
      );
      setSelectedIds(new Set());
      refreshData();
    } catch (err) {
      console.error("Failed bulk duplicate:", err);
    }
  };

  const handleMoveToCollection = async (
    id: string,
    collectionId: string | null,
  ) => {
    moveOutOfCurrentView(
      (drawing) => (drawing.id === id ? { ...drawing, collectionId } : drawing),
      (drawing) => {
        if (selectedCollectionId === undefined) return true;
        if (selectedCollectionId === null) return drawing.collectionId === null;
        return drawing.collectionId === selectedCollectionId;
      },
    );
    try {
      await api.updateDrawing(id, { collectionId });
    } catch (error) {
      if (api.isNetworkError(error)) {
        try {
          await updateCachedDrawingSummary(id, { collectionId });
          await enqueuePendingOp({
            drawingId: id,
            type: "update",
            payload: { collectionId },
          });
        } catch (cacheErr) {
          console.error("Failed to cache offline move:", cacheErr);
        }
        return;
      }
      console.error("Failed to move drawing:", error);
      refreshData();
    }
  };

  const handleDrop = async (
    event: React.DragEvent,
    targetCollectionId: string | null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (isSharedView) return;
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      const files = Array.from(event.dataTransfer.files);
      const libFiles = files.filter((file) =>
        file.name.endsWith(".excalidrawlib"),
      );
      if (libFiles.length > 0) {
        setShowImportError({
          isOpen: true,
          message:
            "Library (.excalidrawlib) imports are not supported in this build. Please import drawings (.excalidraw/.json) instead.",
        });
      }
      const drawingFiles = files.filter(
        (file) => !file.name.endsWith(".excalidrawlib"),
      );
      if (drawingFiles.length > 0) {
        uploadFiles(drawingFiles, targetCollectionId).finally(refreshData);
      }
      return;
    }
    const draggedDrawingId = event.dataTransfer.getData("drawingId");
    if (!draggedDrawingId) return;
    const idsToMove = selectedIds.has(draggedDrawingId)
      ? new Set(selectedIds)
      : new Set([draggedDrawingId]);
    moveOutOfCurrentView(
      (drawing) =>
        idsToMove.has(drawing.id)
          ? { ...drawing, collectionId: targetCollectionId }
          : drawing,
      (drawing) => {
        if (selectedCollectionId === undefined) return true;
        if (selectedCollectionId === null) return drawing.collectionId === null;
        return drawing.collectionId === selectedCollectionId;
      },
    );
    if (selectedIds.has(draggedDrawingId)) setSelectedIds(new Set());
    try {
      await Promise.all(
        Array.from(idsToMove).map((id) =>
          api.updateDrawing(id, { collectionId: targetCollectionId }),
        ),
      );
    } catch (err) {
      if (api.isNetworkError(err)) {
        try {
          await Promise.all(
            Array.from(idsToMove).map((id) =>
              Promise.all([
                updateCachedDrawingSummary(id, { collectionId: targetCollectionId }),
                enqueuePendingOp({
                  drawingId: id,
                  type: "update",
                  payload: { collectionId: targetCollectionId },
                }),
              ]),
            ),
          );
        } catch (cacheErr) {
          console.error("Failed to cache offline drop move:", cacheErr);
        }
        return;
      }
      console.error("Failed to move", err);
      refreshData();
    }
  };

  const dragPreviewDrawings = useMemo(() => {
    if (!potentialDragId) return [];
    if (selectedIds.has(potentialDragId) && selectedIds.size > 1) {
      return drawings.filter((drawing) => selectedIds.has(drawing.id));
    }
    const drawing = drawings.find((item) => item.id === potentialDragId);
    return drawing ? [drawing] : [];
  }, [potentialDragId, selectedIds, drawings]);

  const handleCardMouseDown = (_event: React.MouseEvent, id: string) => {
    setPotentialDragId(id);
  };

  const handleCardDragStart = (event: React.DragEvent) => {
    const preview = document.getElementById("drag-preview");
    if (preview) event.dataTransfer.setDragImage(preview, 80, 50);
  };

  const handlePreviewGenerated = (id: string, preview: string) => {
    setDrawings((current) =>
      current.map((drawing) =>
        drawing.id === id ? { ...drawing, preview } : drawing,
      ),
    );
  };

  return {
    drawingToDelete,
    showBulkDeleteConfirm,
    showImportError,
    viewerActionError,
    isTrashView,
    isSharedView,
    currentCollection,
    isSharedCollection,
    dragPreviewDrawings,
    setDrawingToDelete,
    setShowBulkDeleteConfirm,
    setShowImportError,
    handleViewerActionError,
    handleCreateDrawing,
    handleImportDrawings,
    handleRenameDrawing,
    handleDeleteDrawing,
    executePermanentDelete,
    handleBulkDeleteClick,
    executeBulkPermanentDelete,
    handleBulkMove,
    handleDuplicateDrawing,
    handleBulkDuplicate,
    handleMoveToCollection,
    handleDrop,
    handleCardMouseDown,
    handleCardDragStart,
    handlePreviewGenerated,
  };
};
