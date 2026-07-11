import React from "react";
import { ShareModal } from "../../components/ShareModal";
import { HistoryPanel } from "../../components/HistoryPanel";
import type { DrawingSnapshotFull } from "../../api";

type ActivePreview = { version: number; createdAt: string };

type EditorDialogsProps = {
  drawingId?: string;
  drawingName: string;
  isHistoryOpen: boolean;
  isShareOpen: boolean;
  activePreview: ActivePreview | null;
  onPreview: (snapshot: DrawingSnapshotFull | null) => void;
  onRestore: () => void;
  onCloseHistory: () => void;
  onCloseShare: () => void;
};

export const EditorDialogs: React.FC<EditorDialogsProps> = ({
  drawingId,
  drawingName,
  isHistoryOpen,
  isShareOpen,
  activePreview,
  onPreview,
  onRestore,
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
        activePreview={activePreview}
        onClose={onCloseHistory}
        onPreview={onPreview}
        onRestore={onRestore}
      />
    </>
  );
};
