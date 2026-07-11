import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const certDir = path.join(frontendRoot, "devcert");

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

export async function generateDevCert() {
  const lanIp = getLanIp();
  if (!lanIp) {
    throw new Error("No non-internal IPv4 interface found. Connect to WiFi first.");
  }

  await fs.mkdir(certDir, { recursive: true });

  const altNames = [
    { type: 2, value: "localhost" },
    { type: 2, value: HOSTNAME },
    { type: 7, ip: "127.0.0.1" },
    { type: 7, ip: lanIp },
  ];

  const pems = await selfsigned.generate(
    [
      { name: "commonName", value: HOSTNAME },
      { name: "organizationName", value: "ExcaliDash Dev" },
    ],
    {
      keySize: 2048,
      days: 825,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true },
        {
          name: "keyUsage",
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
    }
  );

  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  const cerPath = path.join(certDir, "excalidash-pwa.cer");
  const publicCerPath = path.join(frontendRoot, "public", "excalidash-pwa.cer");

  await fs.writeFile(certPath, pems.cert, "utf8");
  await fs.writeFile(keyPath, pems.private, "utf8");

  let cerOk = false;
  try {
    execFileSync("openssl", ["x509", "-in", certPath, "-outform", "der", "-out", cerPath], {
      stdio: "pipe",
    });
    await fs.mkdir(path.join(frontendRoot, "public"), { recursive: true });
    await fs.copyFile(cerPath, publicCerPath);
    cerOk = true;
  } catch {
    console.warn("[dev-cert] openssl not available; DER .cer not generated.");
    console.warn("[dev-cert] Install manually: openssl x509 -in cert.pem -outform der -out excalidash-pwa.cer");
  }

  console.log(`[dev-cert] LAN IP: ${lanIp}`);
  console.log(`[dev-cert] Hostnames: localhost, ${HOSTNAME}, 127.0.0.1, ${lanIp}`);
  console.log(`[dev-cert] cert:  ${certPath}`);
  console.log(`[dev-cert] key:   ${keyPath}`);
  if (cerOk) {
    console.log(`[dev-cert] DER:   ${cerPath}  (AirDrop this to your iPhone)`);
    console.log(`[dev-cert] Also served at https://${HOSTNAME}:6767/excalidash-pwa.cer`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  generateDevCert().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
