import os from "node:os";
import mdns from "multicast-dns";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HOSTNAME = "excalidash.local";

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

export function startMdnsResponder() {
  const lanIp = getLanIp();
  if (!lanIp) {
    console.warn("[mdns] No LAN IPv4 found; excalidash.local will not resolve.");
    return { close: () => {} };
  }

  const server = mdns();

  server.on("query", (query) => {
    for (const q of query.questions) {
      if (q.type === "A" && q.name === HOSTNAME) {
        server.respond({
          answers: [
            { name: HOSTNAME, type: "A", ttl: 120, data: lanIp },
          ],
        });
      }
    }
  });

  console.log(`[mdns] Bonjour responding: ${HOSTNAME} -> ${lanIp}`);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  startMdnsResponder();
}
