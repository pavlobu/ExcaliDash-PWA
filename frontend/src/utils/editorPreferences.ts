const AUTO_LOCK_ENABLED_KEY = "excalidash-auto-lock-on-open";

export const isAutoLockOnOpenEnabled = (): boolean => {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage?.getItem?.(AUTO_LOCK_ENABLED_KEY);
  return raw !== "false";
};

export const setAutoLockOnOpenEnabled = (enabled: boolean): void => {
  try {
    window.localStorage?.setItem?.(AUTO_LOCK_ENABLED_KEY, String(enabled));
  } catch {
    // Ignore unavailable storage in private/embedded contexts.
  }
};
