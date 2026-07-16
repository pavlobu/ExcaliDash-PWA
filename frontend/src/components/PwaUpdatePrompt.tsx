import { RefreshCw, X } from "lucide-react";
import { applyUpdate, dismissUpdate, usePwaUpdate } from "../pwa";

export function PwaUpdatePrompt() {
  const { needRefresh } = usePwaUpdate();
  if (!needRefresh) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-2rem)] max-w-md"
      style={{ bottom: "max(env(safe-area-inset-bottom), 1rem)" }}
    >
      <div className="flex items-center gap-3 rounded-2xl border-2 border-black dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,0.2)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-900 dark:text-white">
            A new version is available
          </p>
          <p className="text-xs text-slate-500 dark:text-neutral-400 font-medium">
            Reload to get the latest ExcaliDash.
          </p>
        </div>
        <button
          type="button"
          onClick={() => applyUpdate()}
          className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-xl border-2 border-black dark:border-neutral-700 bg-indigo-600 text-white text-xs font-black uppercase tracking-wider shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-0.5 transition-all"
        >
          <RefreshCw size={14} strokeWidth={2.5} />
          <span>Reload</span>
        </button>
        <button
          type="button"
          onClick={() => dismissUpdate()}
          aria-label="Dismiss update prompt"
          className="inline-flex items-center justify-center h-9 w-9 rounded-xl border-2 border-slate-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-slate-600 dark:text-neutral-300 hover:bg-slate-50 dark:hover:bg-neutral-800 transition-colors"
        >
          <X size={16} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
