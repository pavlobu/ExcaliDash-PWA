import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDevCert } from "./generate-dev-cert.mjs";
import { startMdnsResponder } from "./dev-mdns.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const certDir = path.join(frontendRoot, "devcert");
const HTTPS_PORT = 6767;
const HTTP_REDIRECT_PORT = Number(process.env.DEV_HTTP_PORT) || 6768;

function startHttpRedirect() {
  const server = http.createServer((req, res) => {
    const target = `https://excalidash.local:${HTTPS_PORT}${req.url || "/"}`;
    res.writeHead(301, { Location: target });
    res.end();
  });
  server.listen(HTTP_REDIRECT_PORT, "0.0.0.0", () => {
    console.log(`[dev] HTTP redirect: http://excalidash.local:${HTTP_REDIRECT_PORT} -> https://excalidash.local:${HTTPS_PORT}`);
  });
  return server;
}

async function main() {
  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log("[dev] Reusing existing cert in devcert/ (run `npm run cert` to regenerate)");
  } else {
    await generateDevCert();
  }
  const mdns = startMdnsResponder();
  const httpRedirect = startHttpRedirect();

  const vite = spawn(
    "vite",
    ["--port", "6767", "--host", "--strictPort"],
    {
      cwd: frontendRoot,
      stdio: "inherit",
      shell: true,
    }
  );

  const cleanup = () => {
    if (mdns && typeof mdns.close === "function") mdns.close();
    if (httpRedirect.listening) httpRedirect.close();
    if (!vite.killed) vite.kill();
  };

  vite.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

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
