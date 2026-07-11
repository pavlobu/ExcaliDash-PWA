import { CloudOff, RefreshCw } from "lucide-react";
import { useOffline } from "../context/OfflineContext";
import { isStandalone } from "../pwa";

const baseClass =
  "fixed left-1/2 -translate-x-1/2 z-[9999] bg-amber-500 text-white text-center font-semibold flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs shadow-lg";

export function OfflineBanner() {
  const { isOnline, isSyncing, pendingCount, triggerSync } = useOffline();

  // On iOS standalone PWA, position at bottom to avoid covering the header
  // and toolbar. On desktop, keep at top.
  const positionClass = isStandalone()
    ? "bottom-[calc(env(safe-area-inset-bottom)_+_0.5rem)]"
    : "top-[calc(env(safe-area-inset-top)_+_0.375rem)]";

  if (!isOnline) {
    return (
      <div className={`${baseClass} ${positionClass}`}>
        <CloudOff size={12} className="shrink-0" />
        <span>Offline{pendingCount > 0 ? ` · ${pendingCount} pending` : ""}</span>
      </div>
    );
  }

  if (isSyncing) {
    return (
      <div className={`${baseClass} ${positionClass} bg-indigo-600`}>
        <RefreshCw size={12} className="shrink-0 animate-spin" />
        <span>Syncing…</span>
      </div>
    );
  }

  if (pendingCount > 0) {
    return (
      <div className={`${baseClass} ${positionClass}`}>
        <CloudOff size={12} className="shrink-0" />
        <span>{pendingCount} pending</span>
        <button
          onClick={() => triggerSync()}
          className="ml-1 underline hover:no-underline"
        >
          Sync
        </button>
      </div>
    );
  }

  return null;
}
