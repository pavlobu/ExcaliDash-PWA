import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, RotateCcw, Eye, Clock, WifiOff, EyeOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "../api";
import clsx from "clsx";

type ActivePreview = { version: number; createdAt: string };

type Props = {
  drawingId: string;
  isOpen: boolean;
  activePreview: ActivePreview | null;
  onClose: () => void;
  onRestore: (snapshot: api.DrawingSnapshotFull) => void;
  onPreview: (snapshot: api.DrawingSnapshotFull | null) => void;
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export const HistoryPanel: React.FC<Props> = ({
  drawingId,
  isOpen,
  activePreview,
  onClose,
  onRestore,
  onPreview,
}) => {
  const [snapshots, setSnapshots] = useState<api.DrawingSnapshotSummary[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<api.DrawingSnapshotFull | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const data = await api.getDrawingHistory(drawingId, { limit: 10 });
      setSnapshots(data.snapshots);
      setTotalCount(data.totalCount);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [drawingId]);

  useEffect(() => {
    if (isOpen) {
      loadHistory();
      setPreviewId(null);
      setPreviewData(null);
      setConfirmRestore(null);
      setConfirmDelete(null);
    }
    // When the panel closes, the preview persists on the canvas. The user
    // exits the preview via the "Exit Preview" button in the editor banner,
    // which calls onPreview(null) and clears activePreview.
  }, [isOpen, loadHistory]);

  // Sync the panel's selection with the active preview state. When the
  // user exits preview from the editor banner (activePreview becomes null),
  // clear the panel's internal selection so the highlight disappears.
  useEffect(() => {
    if (!activePreview && previewId) {
      setPreviewId(null);
      setPreviewData(null);
      setPreviewError(false);
    }
  }, [activePreview, previewId]);

  const handlePreview = async (snapshotId: string) => {
    if (previewId === snapshotId) {
      // Toggle off — restore current canvas
      setPreviewId(null);
      setPreviewData(null);
      setPreviewError(false);
      onPreview(null);
      return;
    }
    setPreviewId(snapshotId);
    setPreviewLoading(true);
    setPreviewError(false);
    try {
      const data = await api.getDrawingSnapshot(drawingId, snapshotId);
      setPreviewData(data);
      onPreview(data);
    } catch {
      setPreviewData(null);
      setPreviewError(true);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleRestore = async (snapshotId: string) => {
    if (confirmRestore !== snapshotId) {
      setConfirmRestore(snapshotId);
      setRestoreError(false);
      return;
    }
    setRestoring(true);
    setRestoreError(false);
    try {
      let data = previewData;
      if (!data || data.id !== snapshotId) {
        data = await api.getDrawingSnapshot(drawingId, snapshotId);
      }
      await api.restoreDrawingSnapshot(drawingId, snapshotId);
      onRestore(data);
      onClose();
    } catch (err) {
      setRestoreError(true);
      const isNetwork = api.isNetworkError(err);
      if (isNetwork) {
        toast.error("Restore requires an internet connection. Reconnect and try again.");
      } else {
        toast.error("Failed to restore version. Please try again.");
      }
    } finally {
      setRestoring(false);
      setConfirmRestore(null);
    }
  };

  const handleDelete = async (snapshotId: string) => {
    if (confirmDelete !== snapshotId) {
      setConfirmDelete(snapshotId);
      setDeleteError(false);
      return;
    }
    setDeleting(true);
    setDeleteError(false);
    try {
      await api.deleteDrawingSnapshot(drawingId, snapshotId);
      if (previewId === snapshotId) {
        setPreviewId(null);
        setPreviewData(null);
        setPreviewError(false);
        onPreview(null);
      }
      await loadHistory();
    } catch (err) {
      setDeleteError(true);
      const isNetwork = api.isNetworkError(err);
      if (isNetwork) {
        toast.error("Delete requires an internet connection. Reconnect and try again.");
      } else {
        toast.error("Failed to delete version. Please try again.");
      }
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex justify-end">
      <div
        className="absolute inset-0 bg-neutral-900/20 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-sm bg-white dark:bg-neutral-900 border-l-2 border-black dark:border-neutral-700 shadow-[-4px_0px_0px_0px_rgba(0,0,0,1)] dark:shadow-[-4px_0px_0px_0px_rgba(255,255,255,0.08)] animate-in slide-in-from-right duration-200 flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between pt-[calc(env(safe-area-inset-top)_+_1rem)] pr-4 pb-4 pl-4 border-b-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900">
          <div className="flex items-center gap-2">
            <Clock size={18} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
            <h2 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
              Version History
            </h2>
            {totalCount > 0 && (
              <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide border bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800">
                {totalCount}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-neutral-400 hover:text-neutral-950 dark:hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Active preview bar — visible when a version is being previewed */}
        {activePreview && (
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b-2 border-amber-500 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30">
            <div className="flex items-center gap-2 min-w-0">
              <Eye size={14} className="text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-xs font-bold text-amber-900 dark:text-amber-200 whitespace-nowrap">
                Previewing v{activePreview.version}
              </span>
              <span className="text-[11px] text-amber-700 dark:text-amber-300 truncate">
                {new Date(activePreview.createdAt).toLocaleString()}
              </span>
            </div>
            <button
              onClick={() => onPreview(null)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold rounded-lg border-2 border-amber-600 dark:border-amber-500 bg-white dark:bg-neutral-900 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50 active:translate-y-0.5 transition-all whitespace-nowrap shrink-0"
            >
              <X size={12} strokeWidth={2.5} />
              Exit Preview
            </button>
          </div>
        )}

        {/* Snapshot list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-neutral-400">
              <span className="text-sm font-bold">Loading history...</span>
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center justify-center py-12 text-neutral-400 gap-2">
              <WifiOff size={32} />
              <span className="text-sm font-bold">History unavailable</span>
              <span className="text-xs text-center font-semibold">
                Version history requires an internet connection. Reconnect to view saved versions.
              </span>
            </div>
          ) : snapshots.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-neutral-400 gap-2">
              <Clock size={32} />
              <span className="text-sm font-bold">No history yet</span>
              <span className="text-xs text-center font-semibold">
                Version history is created automatically when you save changes.
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              {snapshots.map((snap) => {
                const isPreviewingThis = previewId === snap.id;
                const hasActivePreview = !!activePreview;
                return (
                <div
                  key={snap.id}
                  className={clsx(
                    "rounded-xl border-2 transition-all duration-200 flex flex-col overflow-hidden",
                    isPreviewingThis
                      ? "border-indigo-600 dark:border-indigo-500 bg-indigo-50/40 dark:bg-indigo-900/10 shadow-[2px_2px_0px_0px_rgba(79,70,229,1)]"
                      : "border-black dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.05)] hover:-translate-y-0.5 hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
                  )}
                >
                  <div className="p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-bold text-neutral-900 dark:text-neutral-100">
                        Version {snap.version}
                      </span>
                      <span className="text-xs font-semibold text-neutral-500 dark:text-neutral-400">
                        {timeAgo(snap.createdAt)}
                      </span>
                    </div>
                    <div className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 mb-3">
                      {new Date(snap.createdAt).toLocaleString()}
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handlePreview(snap.id)}
                        disabled={hasActivePreview && !isPreviewingThis}
                        className={clsx(
                          "flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border-2 transition-all duration-200 active:translate-x-[1px] active:translate-y-[1px] active:shadow-none disabled:opacity-40 disabled:cursor-not-allowed",
                          isPreviewingThis
                            ? "bg-indigo-600 text-white border-indigo-600 shadow-[1px_1px_0px_0px_rgba(0,0,0,0.15)]"
                            : "bg-white dark:bg-neutral-900 text-slate-700 dark:text-neutral-300 border-black dark:border-neutral-600 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5"
                        )}
                      >
                        {isPreviewingThis ? (
                          <>
                            <EyeOff size={12} strokeWidth={2.5} />
                            Hide
                          </>
                        ) : (
                          <>
                            <Eye size={12} strokeWidth={2.5} />
                            Preview
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => handleRestore(snap.id)}
                        disabled={restoring || (hasActivePreview && !isPreviewingThis)}
                        className={clsx(
                          "flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border-2 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed active:translate-x-[1px] active:translate-y-[1px] active:shadow-none",
                          confirmRestore === snap.id
                            ? "bg-amber-500 text-white border-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] animate-pulse"
                            : "bg-white dark:bg-neutral-900 text-slate-700 dark:text-neutral-300 border-black dark:border-neutral-600 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5"
                        )}
                      >
                        <RotateCcw size={12} strokeWidth={2.5} />
                        {confirmRestore === snap.id
                          ? "Confirm?"
                          : restoring
                          ? "Restoring..."
                          : "Restore"}
                      </button>
                      <button
                        onClick={() => handleDelete(snap.id)}
                        disabled={deleting || restoring || (hasActivePreview && !isPreviewingThis)}
                        className={clsx(
                          "flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg border-2 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed active:translate-x-[1px] active:translate-y-[1px] active:shadow-none",
                          confirmDelete === snap.id
                            ? "bg-red-500 text-white border-black shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] animate-pulse"
                            : "bg-white dark:bg-neutral-900 text-red-600 dark:text-red-400 border-black dark:border-neutral-600 shadow-[1.5px_1.5px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5"
                        )}
                      >
                        <Trash2 size={12} strokeWidth={2.5} />
                        {confirmDelete === snap.id
                          ? "Confirm?"
                          : deleting
                          ? "Deleting..."
                          : "Delete"}
                      </button>
                    </div>
                  </div>

                  {/* Preview info pane */}
                  {isPreviewingThis && (
                    <div className="border-t-2 border-black dark:border-neutral-700 p-3 bg-indigo-50/20 dark:bg-indigo-900/5">
                      {previewLoading ? (
                        <span className="text-[10px] font-semibold text-neutral-400">
                          Loading preview...
                        </span>
                      ) : previewData ? (
                        <div className="text-[11px] text-neutral-500 dark:text-neutral-400 space-y-1 font-semibold">
                          <div>
                            <span className="font-bold text-neutral-600 dark:text-neutral-300">Active Elements:</span>{" "}
                            {Array.isArray(previewData.elements)
                              ? previewData.elements.filter(
                                  (e) => !(e as Record<string, unknown>).isDeleted
                                ).length
                              : 0}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[10px] font-bold text-red-500">
                          {previewError ? "Failed to load preview" : "No preview data"}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Restore error */}
                  {restoreError && confirmRestore === snap.id && (
                    <div className="border-t-2 border-red-300 dark:border-red-800 p-2 bg-red-50 dark:bg-red-900/20">
                      <span className="text-[10px] font-bold text-red-600 dark:text-red-400">
                        Restore failed — check your connection and try again.
                      </span>
                    </div>
                  )}

                  {/* Delete error */}
                  {deleteError && confirmDelete === snap.id && (
                    <div className="border-t-2 border-red-300 dark:border-red-800 p-2 bg-red-50 dark:bg-red-900/20">
                      <span className="text-[10px] font-bold text-red-600 dark:text-red-400">
                        Delete failed — check your connection and try again.
                      </span>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-4 pr-4 pb-[calc(env(safe-area-inset-bottom)_+_1rem)] pl-4 border-t-2 border-black dark:border-neutral-700 bg-slate-50 dark:bg-neutral-800/50">
          <p className="text-[10px] font-bold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 text-center">
            Versions are kept for 2 days
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
};
