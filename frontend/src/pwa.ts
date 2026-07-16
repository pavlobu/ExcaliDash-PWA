import { useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";

export function isStandalone() {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const isIosStandalone = nav.standalone === true;
  const isDisplayModeStandalone = window.matchMedia("(display-mode: standalone)").matches;
  return isIosStandalone || isDisplayModeStandalone;
}

const AUTO_UPDATE_KEY = "excalidash-pwa-auto-update";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const safeGet = (key: string): string | null => {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
};

const safeSet = (key: string, value: string): void => {
  try {
    if (typeof window === "undefined") return;
    window.localStorage?.setItem?.(key, value);
  } catch {
    // Ignore unavailable storage in private/embedded contexts.
  }
};

// Auto-update defaults to on: new deployments reload installed PWAs without
// forcing users to manually reinstall. A toggle lives in Settings.
export function isAutoUpdateEnabled(): boolean {
  return safeGet(AUTO_UPDATE_KEY) !== "false";
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  safeSet(AUTO_UPDATE_KEY, String(enabled));
  notifyAutoUpdateListeners();
}

type PwaUpdateState = { needRefresh: boolean };

let state: PwaUpdateState = { needRefresh: false };
const listeners = new Set<() => void>();
const autoUpdateListeners = new Set<() => void>();

const setState = (next: PwaUpdateState) => {
  state = next;
  listeners.forEach((l) => l());
};

const notifyAutoUpdateListeners = () => autoUpdateListeners.forEach((l) => l());

let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | null = null;

// Registers the service worker through vite-plugin-pwa's virtual module so the
// update lifecycle (needRefresh / offlineReady / registered) is observable.
// Replaces the previous bare `navigator.serviceWorker.register('/sw.js')`,
// which silently activated new SW versions but never reloaded the page,
// leaving installed PWAs stuck on stale code until a manual reinstall.
export function registerPwaUpdater() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (updateServiceWorker) return;

  updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      // In dev the vite-plugin-pwa dev SW churns on every change; let Vite
      // HMR handle it and avoid reload loops / noisy prompts.
      if (import.meta.env.DEV) return;
      if (isAutoUpdateEnabled()) {
        void applyUpdate();
        return;
      }
      setState({ needRefresh: true });
    },
    onOfflineReady() {
      console.info("[PWA] App is ready to work offline.");
    },
    onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;
      // Poll for an updated service worker so installed / long-open PWAs pick
      // up new deployments without waiting for the user to navigate.
      setInterval(() => {
        if (navigator.onLine) {
          registration.update().catch((err) => {
            console.warn("[PWA] Update check failed:", err);
          });
        }
      }, UPDATE_CHECK_INTERVAL_MS);
    },
    onRegisterError(error: unknown) {
      console.warn("[PWA] Service worker registration failed:", error);
    },
  });
}

// Activate the waiting SW and reload. Falls back to a hard reload if the
// updater was never initialised (e.g. SW unsupported in this browser).
export function applyUpdate(): void {
  if (!updateServiceWorker) {
    window.location.reload();
    return;
  }
  void updateServiceWorker(true);
}

export function dismissUpdate(): void {
  setState({ needRefresh: false });
}

export function usePwaUpdate(): PwaUpdateState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
    () => state,
  );
}

export function useAutoUpdateEnabled(): [boolean, (next: boolean) => void] {
  const subscribe = (cb: () => void) => {
    autoUpdateListeners.add(cb);
    return () => {
      autoUpdateListeners.delete(cb);
    };
  };
  const getSnapshot = () => isAutoUpdateEnabled();
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const set = (next: boolean) => setAutoUpdateEnabled(next);
  return [enabled, set];
}
