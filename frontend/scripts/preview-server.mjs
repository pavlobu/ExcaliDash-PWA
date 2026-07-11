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
const BACKEND_URL = process.env.VITE_DEV_BACKEND_URL?.trim() || "https://localhost:8000";

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

function proxyHttp(req, res) {
  // Strip /api prefix — same as Vite dev proxy rewrite.
  const backendPath = req.url.replace(/^\/api/, "");
  const targetUrl = BACKEND_URL + backendPath;
  const parsed = new URL(targetUrl);
  const isSecure = parsed.protocol === "https:";
  const transport = isSecure ? https : http;
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isSecure ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: { ...req.headers, host: parsed.host },
    rejectUnauthorized: false,
  };
  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Backend unreachable", message: err.message }));
    }
  });
  req.pipe(proxyReq);
}

function proxyWebSocket(req, socket, head) {
  const parsed = new URL(BACKEND_URL);
  const isSecure = parsed.protocol === "https:";
  const transport = isSecure ? https : http;
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isSecure ? 443 : 80),
    path: req.url,
    method: "GET",
    headers: { ...req.headers, host: parsed.host },
    rejectUnauthorized: false,
  };
  const proxyReq = transport.request(options);
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    res_proxy_ws(proxyRes, proxySocket, proxyHead);
  });
  proxyReq.on("error", (err) => {
    console.error("[preview] WebSocket proxy error:", err.message);
    socket.destroy();
  });
  if (head && head.length > 0) {
    proxyReq.write(head);
  }
  proxyReq.end();

  function res_proxy_ws(proxyRes, proxySocket, proxyHead) {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (proxyHead && proxyHead.length > 0) {
      socket.write(proxyHead);
    }
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  }
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
    // Proxy /api/ requests to the backend (same as Vite dev proxy).
    if (req.url?.startsWith("/api/")) {
      proxyHttp(req, res);
      return;
    }
    serveStatic(req, res, distDir);
  });

  // Proxy WebSocket upgrades for /socket.io/ to enable realtime collaboration.
  httpsServer.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/socket.io/")) {
      proxyWebSocket(req, socket, head);
      return;
    }
    socket.destroy();
  });

  httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`[preview] Production build served at:`);
    console.log(`[preview]   https://excalidash.local:${HTTPS_PORT}`);
    console.log(`[preview]   https://localhost:${HTTPS_PORT}`);
    console.log(`[preview] Backend API proxy: ${BACKEND_URL}`);
    console.log(`[preview] Start backend: cd backend && npm run start`);
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
