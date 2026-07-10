export function isStandalone() {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const isIosStandalone = nav.standalone === true;
  const isDisplayModeStandalone = window.matchMedia("(display-mode: standalone)").matches;
  return isIosStandalone || isDisplayModeStandalone;
}

export function registerServiceWorker() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  const swPath = "/sw.js";

  const register = () => {
    navigator.serviceWorker
      .register(swPath, { scope: "/" })
      .then((registration) => {
        console.log("[PWA] Service worker registered:", registration.scope);
        if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
          console.log("[PWA] Service worker is controlling the page.");
        } else {
          console.warn("[PWA] Service worker registered but not controlling the page yet.");
        }
      })
      .catch((error) => {
        console.warn("[PWA] Service worker registration failed:", error);
      });
  };

  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register);
  }
}
