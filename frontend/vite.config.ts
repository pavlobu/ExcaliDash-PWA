import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { VitePWA } from "vite-plugin-pwa";
// @ts-expect-error - .mjs plugin works at runtime via Vite, no type defs needed
import { devServiceWorkerPlugin } from "./scripts/dev-sw-plugin.mjs";

const versionFilePath = path.resolve(__dirname, "../VERSION");
let versionFromFile = "0.0.0";

try {
  const raw = fs.readFileSync(versionFilePath, "utf8").trim();
  if (raw) {
    versionFromFile = raw;
  }
} catch (error) {
  console.warn("Unable to read VERSION file:", error);
}

const appVersion = process.env.VITE_APP_VERSION?.trim() || versionFromFile;
const buildLabel = process.env.VITE_APP_BUILD_LABEL?.trim() || "local development build";

const certDir = path.resolve(__dirname, "devcert");
const certFile = path.join(certDir, "cert.pem");
const keyFile = path.join(certDir, "key.pem");
const devCert =
  fs.existsSync(certFile) && fs.existsSync(keyFile)
    ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
    : undefined;

export default defineConfig(({ command }) => {
  const nodeEnv = process.env.NODE_ENV || (command === "build" ? "production" : "development");
  const devBackendTarget = process.env.VITE_DEV_BACKEND_URL?.trim() || "http://localhost:8000";
  const processEnvDefines = {
    'process.env.IS_PREACT': JSON.stringify("false"),
    'process.env.NODE_ENV': JSON.stringify(nodeEnv),
  };

  return {
    plugins: [
      react(),
      devServiceWorkerPlugin(),
      VitePWA({
        registerType: "prompt",
        // Register the SW manually via the `virtual:pwa-register` module in
        // `src/pwa.ts` so we can drive the update lifecycle (prompt / auto
        // reload). Auto-injection is disabled to avoid double registration.
        injectRegister: false,
        manifest: {
          name: "ExcaliDash",
          short_name: "ExcaliDash",
          id: "/",
          description:
            "A self-hosted dashboard and organizer for Excalidraw drawings",
          theme_color: "#4f46e5",
          background_color: "#ffffff",
          display: "standalone",
          orientation: "any",
          scope: "/",
          start_url: "/",
          icons: [
            {
              src: "/icon-192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/icon-512.png",
              sizes: "512x512",
              type: "image/png",
            },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
          // Exclude Excalidraw fonts from precache — there are 234 woff2 files
          // which bloats the precache manifest and slows SW installation.
          // Fonts are cached at runtime via the StaleWhileRevalidate rule below.
          globIgnores: ["**/fonts/**"],
          navigateFallback: "index.html",
          navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//, /^\/auth\//],
          // Let a newly installed SW wait, then activate it explicitly via the
          // prompt flow in `src/pwa.ts` (posts SKIP_WAITING on user action or
          // when auto-update is enabled). `clientsClaim` still makes the first
          // install take control immediately, which keeps iOS standalone PWAs
          // from launching offline into a blank page.
          skipWaiting: false,
          clientsClaim: true,
          runtimeCaching: [
            {
              // Stale-while-revalidate for fonts: serve from cache instantly
              // (critical for offline PWA), update in background when online.
              urlPattern: ({ url }) => url.pathname.startsWith("/fonts/"),
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "excalidraw-fonts",
                expiration: {
                  maxEntries: 300,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "google-fonts-cache",
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "google-fonts-cache",
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
              },
            },
            {
              urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
              handler: "NetworkOnly",
              method: "GET",
              options: {
                backgroundSync: {
                  name: "api-queue",
                  options: {
                    maxRetentionTime: 24 * 60,
                  },
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: "classic",
        },
      }),
    ],
    define: {
      ...processEnvDefines,
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_APP_BUILD_LABEL': JSON.stringify(buildLabel),
    },
    optimizeDeps: {
      esbuildOptions: {
        define: processEnvDefines,
        target: "es2022",
      },
    },
    server: {
      https: devCert,
      host: true,
      port: 6767,
      strictPort: true,
      proxy: {
        "/api": {
          target: devBackendTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
        "/socket.io": {
          target: devBackendTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
