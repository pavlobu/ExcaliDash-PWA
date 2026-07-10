import { CloudOff, RefreshCw } from "lucide-react";
import { useOffline } from "../context/OfflineContext";

export function OfflineBanner() {
  const { isOnline, isSyncing, pendingCount, triggerSync } = useOffline();

  if (!isOnline) {
    return (
      <div className="fixed top-0 left-0 right-0 z-[9999] bg-amber-500 text-white text-center text-xs sm:text-sm font-bold pt-[calc(env(safe-area-inset-top)_+_0.375rem)] pb-1.5 px-4 flex items-center justify-center gap-2">
        <CloudOff size={14} className="shrink-0" />
        <span>Offline mode — changes saved locally{pendingCount > 0 ? ` (${pendingCount} pending)` : ""}</span>
      </div>
    );
  }

  if (isSyncing) {
    return (
      <div className="fixed top-0 left-0 right-0 z-[9999] bg-indigo-600 text-white text-center text-xs sm:text-sm font-bold pt-[calc(env(safe-area-inset-top)_+_0.375rem)] pb-1.5 px-4 flex items-center justify-center gap-2">
        <RefreshCw size={14} className="shrink-0 animate-spin" />
        <span>Syncing changes to server…</span>
      </div>
    );
  }

  if (pendingCount > 0) {
    return (
      <div className="fixed top-0 left-0 right-0 z-[9999] bg-amber-500 text-white text-center text-xs sm:text-sm font-bold pt-[calc(env(safe-area-inset-top)_+_0.375rem)] pb-1.5 px-4 flex items-center justify-center gap-2">
        <CloudOff size={14} className="shrink-0" />
        <span>{pendingCount} change{pendingCount !== 1 ? "s" : ""} pending sync</span>
        <button
          onClick={() => triggerSync()}
          className="ml-2 underline hover:no-underline"
        >
          Sync now
        </button>
      </div>
    );
  }

  return null;
}
