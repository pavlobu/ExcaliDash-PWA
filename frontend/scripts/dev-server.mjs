import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDevCert } from "./generate-dev-cert.mjs";
import { startMdnsResponder } from "./dev-mdns.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const certDir = path.join(frontendRoot, ".devcert");

async function main() {
  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log("[dev] Reusing existing cert in .devcert/ (run `npm run cert` to regenerate)");
  } else {
    await generateDevCert();
  }
  const mdns = startMdnsResponder();

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
