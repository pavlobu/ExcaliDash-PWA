import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDevCert } from "./generate-dev-cert.mjs";
import { startMdnsResponder } from "./dev-mdns.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const certDir = path.join(frontendRoot, "devcert");
const HTTPS_PORT = 6767;
const HTTP_REDIRECT_PORT = Number(process.env.DEV_HTTP_PORT) || 6768;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function serveStatic(req, res, distDir) {
  let urlPath = req.url || "/";
  if (urlPath.includes("?")) urlPath = urlPath.split("?")[0];

  if (urlPath === "/sw.js") {
    const swPath = path.join(distDir, "sw.js");
    if (fs.existsSync(swPath)) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      fs.createReadStream(swPath).pipe(res);
      return;
    }
  }

  let filePath = path.join(distDir, urlPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  res.setHeader("Content-Type", mime);

  if (filePath.endsWith("index.html") || filePath.endsWith("sw.js") || urlPath.includes("/manifest")) {
    res.setHeader("Cache-Control", "no-cache");
  } else {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }

  fs.createReadStream(filePath).pipe(res);
}

function startHttpRedirect() {
  const server = http.createServer((req, res) => {
    const target = `https://excalidash.local:${HTTPS_PORT}${req.url || "/"}`;
    res.writeHead(301, { Location: target });
    res.end();
  });
  server.listen(HTTP_REDIRECT_PORT, "0.0.0.0", () => {
    console.log(`[preview] HTTP redirect: http://excalidash.local:${HTTP_REDIRECT_PORT} -> https://excalidash.local:${HTTPS_PORT}`);
  });
  return server;
}

async function main() {
  const distDir = path.join(frontendRoot, "dist");
  if (!fs.existsSync(distDir)) {
    console.log("[preview] dist/ not found, building...");
    await new Promise((resolve, reject) => {
      const build = spawn("npm", ["run", "build"], {
        cwd: frontendRoot,
        stdio: "inherit",
        shell: true,
      });
      build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Build failed: ${code}`))));
    });
  }

  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    await generateDevCert();
  }

  const mdns = startMdnsResponder();
  const httpRedirect = startHttpRedirect();

  const httpsOptions = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };

  const httpsServer = https.createServer(httpsOptions, (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "preview" }));
      return;
    }
    serveStatic(req, res, distDir);
  });

  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`[preview] Production build served at:`);
    console.log(`[preview]   https://excalidash.local:${HTTPS_PORT}`);
    console.log(`[preview]   https://localhost:${HTTPS_PORT}`);
    console.log(`[preview] Backend API proxy NOT active in preview mode.`);
    console.log(`[preview] Start backend separately: cd backend && npm run dev`);
  });

  const cleanup = () => {
    if (mdns && typeof mdns.close === "function") mdns.close();
    if (httpRedirect.listening) httpRedirect.close();
    httpsServer.close();
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
