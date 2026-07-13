import React from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import {
  ArrowLeft,
  Download,
  History,
  Loader2,
  Lock,
  LockOpen,
  Share2,
  EyeOff,
  Type,
  X,
} from "lucide-react";
import clsx from "clsx";
import { Toaster } from "sonner";
import {
  LanguageSelector,
} from "../../components/LanguageSelector";
import type { UserIdentity } from "../../utils/identity";
import { UIOptions } from "./shared";
import { RichTextWidgetLayer } from "./RichTextWidgetLayer";
import type { MutableRefObject } from "react";

interface Peer extends UserIdentity {
  isActive: boolean;
}

type ActivePreview = { version: number; createdAt: string };

type EditorViewProps = {
  id?: string;
  accessLevel: "none" | "view" | "edit" | "owner";
  activePreview: ActivePreview | null;
  autoHideEnabled: boolean;
  canEdit: boolean;
  drawingName: string;
  editorContainerRef: React.RefObject<HTMLDivElement>;
  initialData: any;
  isHeaderVisible: boolean;
  isLocked: boolean;
  isRenaming: boolean;
  isSavingOnLeave: boolean;
  isSceneLoading: boolean;
  langCode: string;
  loadError: string | null;
  me: UserIdentity;
  newName: string;
  peers: Peer[];
  theme: string;
  onBackClick: () => void;
  onCanvasChange: (elements: readonly any[], appState: any, files?: Record<string, any>) => void;
  onCanvasDropCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onExitPreview: () => void;
  onExportClick: () => void;
  onLibraryChange: (items: readonly any[]) => void;
  onNavigateHome: () => void;
  onNewNameChange: (value: string) => void;
  onPointerUpdate: (payload: any) => void;
  onRenameBlur: () => void;
  onRenameCancel: () => void;
  onRenameStart: () => void;
  onRenameSubmit: (event: React.FormEvent) => void;
  onSetExcalidrawAPI: (api: any) => void;
  onSetLangCode: (langCode: string) => void;
  onShareOpen: () => void;
  onHistoryOpen: () => void;
  onToggleAutoHide: () => void;
  onToggleLock: () => void;
  onHideHeader: () => void;
  canEditRichText: boolean;
  excalidrawAPIRef: MutableRefObject<any>;
  latestElementsRef: MutableRefObject<readonly any[]>;
  latestAppStateRef: MutableRefObject<any>;
  onRichTextCommit: (elementId: string, json: unknown, plainText: string) => void;
  onInsertRichTextWidget: () => void;
};

const UserAvatar = ({
  user,
  label,
  inactive = false,
}: {
  user: UserIdentity;
  label: string;
  inactive?: boolean;
}) => (
  <div className="relative group">
    <div
      className={clsx(
        "w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white shadow-sm transition-all duration-300",
        inactive && "opacity-30 grayscale",
      )}
      style={{ backgroundColor: user.color }}
    >
      {user.initials}
    </div>
    <div className="absolute top-full mt-2 right-0 bg-gray-900 text-white text-xs py-1 px-2 rounded whitespace-nowrap z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
      {label}
    </div>
  </div>
);

export const EditorView: React.FC<EditorViewProps> = ({
  id,
  accessLevel,
  activePreview,
  canEdit,
  drawingName,
  editorContainerRef,
  initialData,
  isHeaderVisible,
  isLocked,
  isRenaming,
  isSavingOnLeave,
  isSceneLoading,
  langCode,
  loadError,
  me,
  newName,
  peers,
  theme,
  onBackClick,
  onCanvasChange,
  onCanvasDropCapture,
  onExitPreview,
  onExportClick,
  onLibraryChange,
  onNavigateHome,
  onNewNameChange,
  onPointerUpdate,
  onRenameBlur,
  onRenameCancel,
  onRenameStart,
  onRenameSubmit,
  onSetExcalidrawAPI,
  onSetLangCode,
  onShareOpen,
  onHistoryOpen,
  onToggleLock,
  onHideHeader,
  canEditRichText,
  excalidrawAPIRef,
  latestElementsRef,
  latestAppStateRef,
  onRichTextCommit,
  onInsertRichTextWidget,
}) => (
  <div className="h-screen flex flex-col bg-white dark:bg-neutral-950 overflow-hidden">
    <header
      className={clsx(
        "bg-white dark:bg-neutral-900 border-b border-gray-200 dark:border-neutral-800 z-10 fixed top-0 left-0 right-0 transition-transform duration-300",
        isHeaderVisible ? "translate-y-0" : "-translate-y-full",
      )}
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="h-16 flex items-center px-2 sm:px-4 justify-between gap-2">
      <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-shrink-0">
        <button
          onClick={onBackClick}
          disabled={isSavingOnLeave}
          className={`flex items-center gap-2 p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-full text-gray-600 dark:text-gray-300 disabled:opacity-50 disabled:cursor-wait transition-all duration-200 flex-shrink-0 ${isSavingOnLeave ? "pr-4" : ""}`}
        >
          {isSavingOnLeave ? (
            <>
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm font-medium hidden sm:inline">Saving...</span>
            </>
          ) : (
            <ArrowLeft size={20} />
          )}
        </button>
        {isRenaming ? (
          <form onSubmit={onRenameSubmit} className="min-w-0">
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => onNewNameChange(e.target.value)}
              onBlur={onRenameBlur}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRenameCancel();
              }}
              className="font-medium text-gray-900 dark:text-white bg-transparent px-2 py-1 border-2 border-indigo-500 rounded-md outline-none min-w-[120px] sm:min-w-[200px]"
              style={{ width: `${Math.max(120, newName.length * 9 + 20)}px` }}
            />
          </form>
        ) : (
          <h1
            className="font-medium text-gray-900 dark:text-white px-2 py-1 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded cursor-text truncate max-w-[40vw] sm:max-w-none"
            onClick={onRenameStart}
          >
            {drawingName}
          </h1>
        )}
      </div>
      <div className="flex items-center gap-1 sm:gap-3 overflow-x-auto no-scrollbar flex-shrink-0">
        {!canEdit ? (
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200 border border-amber-200 dark:border-amber-800 flex-shrink-0">
            Read-only
          </span>
        ) : null}
        {canEdit && id ? (
          <button
            onClick={onToggleLock}
            className={`p-2 rounded-lg transition-colors flex-shrink-0 ${
              isLocked
                ? "bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-900/60"
                : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
            }`}
            title={isLocked ? "Unlock drawing" : "Lock drawing"}
            aria-label={isLocked ? "Unlock drawing" : "Lock drawing"}
            aria-pressed={isLocked}
          >
            {isLocked ? <Lock size={20} /> : <LockOpen size={20} />}
          </button>
        ) : null}
        {canEdit && id ? (
          <button
            onClick={onHistoryOpen}
            className="p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors flex-shrink-0"
            title="Version History"
          >
            <History size={20} />
          </button>
        ) : null}
        {accessLevel === "owner" && id ? (
          <button
            onClick={onShareOpen}
            className="p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors flex-shrink-0"
            title="Share"
          >
            <Share2 size={20} />
          </button>
        ) : null}
        <button
          onClick={onHideHeader}
          className="p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors flex-shrink-0"
          title="Hide header"
        >
          <EyeOff size={20} />
        </button>
        <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 flex-shrink-0" />
        <button
          onClick={onExportClick}
          className="p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg text-gray-600 dark:text-gray-300 transition-colors flex-shrink-0"
          title="Export drawing"
        >
          <Download size={20} />
        </button>
        <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 flex-shrink-0" />
        <div className="flex items-center flex-shrink-0">
          <UserAvatar user={me} label={`${me.name} (You)`} />
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-2" />
          <div className="flex items-center gap-2">
            {peers.map((peer) => (
              <UserAvatar
                key={peer.id}
                user={peer}
                label={peer.name}
                inactive={!peer.isActive}
              />
            ))}
          </div>
        </div>
      </div>
      </div>
    </header>
    <div
      ref={editorContainerRef}
      className="flex-1 w-full relative transition-all duration-300"
      onDropCapture={onCanvasDropCapture}
      style={{
        height: isHeaderVisible
          ? "calc(100vh - 4rem - env(safe-area-inset-top) - env(safe-area-inset-bottom))"
          : "calc(100vh - env(safe-area-inset-bottom))",
        marginTop: isHeaderVisible ? "calc(4rem + env(safe-area-inset-top))" : "0",
        marginBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {activePreview && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-[15] flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/80 border-2 border-amber-500 dark:border-amber-600 rounded-xl shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] dark:shadow-[2px_2px_0px_0px_rgba(255,255,255,0.2)] max-w-[calc(100%-1.5rem)] animate-in fade-in slide-in-from-bottom-2 duration-200">
          <History size={14} className="text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-xs font-bold text-amber-900 dark:text-amber-200 whitespace-nowrap">
            v{activePreview.version}
          </span>
          <span className="text-xs text-amber-700 dark:text-amber-300 hidden sm:inline truncate">
            {new Date(activePreview.createdAt).toLocaleString()}
          </span>
          <div className="w-px h-4 bg-amber-400 dark:bg-amber-600 shrink-0" />
          <button
            onClick={onExitPreview}
            className="flex items-center gap-1 px-2 py-0.5 text-xs font-bold rounded-lg border-2 border-amber-600 dark:border-amber-500 bg-white dark:bg-neutral-900 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50 active:translate-y-0.5 transition-all whitespace-nowrap"
          >
            <X size={12} strokeWidth={2.5} />
            Exit Preview
          </button>
        </div>
      )}
      {loadError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white dark:bg-neutral-950 px-6">
          <div className="text-center">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              Unable to open drawing
            </h2>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {loadError}
            </p>
          </div>
          <button
            onClick={onNavigateHome}
            className="px-4 py-2 rounded-lg border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 text-gray-900 dark:text-gray-100 font-semibold hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
          >
            Back to dashboard
          </button>
        </div>
      ) : initialData ? (
        <Excalidraw
          key={id}
          theme={theme === "dark" ? "dark" : "light"}
          langCode={langCode}
          initialData={initialData}
          onChange={onCanvasChange}
          onPointerUpdate={onPointerUpdate}
          onLibraryChange={onLibraryChange}
          excalidrawAPI={onSetExcalidrawAPI}
          UIOptions={UIOptions}
          viewModeEnabled={!canEdit || !!activePreview || isLocked}
        >
          <MainMenu>
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.Help />
            <MainMenu.Separator />
            <MainMenu.ItemCustom>
              <LanguageSelector langCode={langCode} onChange={onSetLangCode} />
            </MainMenu.ItemCustom>
          </MainMenu>
        </Excalidraw>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-500 dark:text-gray-400">
          <Loader2 size={28} className="animate-spin" />
          <span className="text-sm font-medium">
            {isSceneLoading ? "Loading drawing..." : "Preparing canvas..."}
          </span>
        </div>
      )}
      {canEditRichText && (
        <button
          onClick={onInsertRichTextWidget}
          className="fixed z-[15] left-3 sm:left-4 top-[52px] flex items-center gap-1.5 px-2.5 py-1.5 bg-white/95 dark:bg-neutral-900/95 backdrop-blur border-2 border-black dark:border-neutral-700 rounded-xl shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.2)] text-slate-900 dark:text-neutral-100 text-xs font-bold hover:-translate-y-0.5 transition-all"
          title="Insert rich text paragraph"
          aria-label="Insert rich text paragraph"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Type size={16} strokeWidth={2.5} />
          Rich Text
        </button>
      )}
      {canEditRichText && initialData && (
        <RichTextWidgetLayer
          excalidrawAPIRef={excalidrawAPIRef}
          latestElementsRef={latestElementsRef}
          latestAppStateRef={latestAppStateRef}
          onCommit={onRichTextCommit}
        />
      )}
      <Toaster position="bottom-center" />
    </div>
  </div>
);
