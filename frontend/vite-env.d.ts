declare module "./scripts/dev-sw-plugin.mjs" {
  import type { Plugin } from "vite";
  export function devServiceWorkerPlugin(): Plugin;
}
