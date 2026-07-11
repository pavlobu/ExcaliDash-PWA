# ExcaliDash with Custom SSL + Bonjour Discovery

This guide explains how to generate your own TLS certificates, run the
ExcaliDash **PWA** stack over HTTPS, and — just as importantly — produce the
`excalidash-pwa.cer` file you install on your **browsers and mobile devices** as a
trusted certificate so the PWA installs as a standalone app with no security
warnings.

The standard images (`pavlobuidenkov/excalidash-pwa-*`) remain unchanged. The PWA
images are a separate image set published under the `excalidash-pwa` name.

The SSL stack keeps the standard ExcaliDash host port **6767**: the frontend
HTTPS listener (container port 443) is published on host port 6767, so the app
does not grab privileged ports 80/443 on the host machine.

---

## 1. How it works

- **Frontend** (`nginx`) serves HTTPS (container port 443) using your cert/key,
  published on host port 6767. At container startup the entrypoint
  (`frontend/docker-entrypoint.sh`) picks the SSL nginx template
  (`frontend/nginx.ssl.conf.template`) when the cert files exist, otherwise it
  falls back to the plain-HTTP template. Cert paths default to
  `/certs/fullchain.pem` and `/certs/privkey.pem` (overridable via `SSL_CERT_PATH`
  / `SSL_KEY_PATH`).
- **Backend** already supports direct HTTPS via `HTTPS_CERT_PATH` /
  `HTTPS_KEY_PATH` (`backend/src/index.ts`). With the SSL compose the frontend
  nginx terminates TLS and proxies to the backend over the internal bridge
  network, so the backend keeps running plain HTTP internally. Set
  `FRONTEND_URL=https://excalidash.local:6767` so CORS/origin checks match.
- **Bonjour**: an `avahi` sidecar advertises `_https._tcp` as
  `excalidash.local` on port 6767. On Linux it uses host networking to reach
  Wi-Fi. On macOS/Windows (Docker Desktop) mDNS does not bridge to the host
  Wi-Fi, so run `scripts/register-bonjour.sh` on the host instead.

### Why a *self-signed CA* certificate (not just a server cert)

The dev server already does this — see `frontend/scripts/generate-dev-cert.mjs`,
which produces `frontend/devcert/{cert.pem,key.pem,excalidash-pwa.cer}`. We mirror
that exact recipe here so the same certificate both serves TLS **and** can be
trusted on devices:

- The cert is its own root (`basicConstraints = CA:TRUE` + `keyCertSign`). iOS
  only shows the **Certificate Trust Settings** toggle (required for Safari to
  stop warning and for Add-to-Home-Screen to behave as a standalone PWA) for
  certificates that are a CA. A plain leaf cert can be *installed* on iOS but
  **cannot** be fully trusted — so the PWA keeps warning. mkcert leaf certs have
  the same limitation on mobile unless you install mkcert's root CA.
- The Subject Alternative Name (SAN) lists `localhost`, `excalidash.local`,
  `127.0.0.1`, **and your machine's LAN IP**, so phones on the same Wi-Fi can
  reach the app by hostname (via Bonjour) or by IP.
- We also emit a DER copy, `excalidash-pwa.cer`, which is the format iOS, Android,
  macOS Keychain, and Windows certmgr expect when you install a custom trusted
  certificate.

---

## 2. Generate your SSL certificates

The compose file expects these files **in the same folder as
`docker-compose.prod.ssl.yml`**:

```
certs/fullchain.pem        # certificate (self-signed CA, also valid as server cert)
certs/privkey.pem          # unencrypted private key
certs/excalidash-pwa.cer   # DER copy you install on your devices (do NOT put on the server path)
```

### Step 2a — Find your machine's LAN IP (optional)

Phones reach the app over your Wi-Fi, so the cert must list your host's LAN IP.
Run the matching line for your OS:

```sh
# macOS (Wi-Fi is usually en0; some Macs use en1):
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

# Linux:
# LAN_IP=$(hostname -I | awk '{print $1}')

echo "$LAN_IP"   # e.g. 192.168.0.244
```

> If `LAN_IP` is empty you are not on Wi-Fi/Ethernet — connect first, or leave the
> `IP.2` line out of the config in Step 2b (you can still use `excalidash.local`
> and `localhost`).

### Step 2b — Generate the certificate with OpenSSL (recommended)

This method uses a small config file and works with **both** LibreSSL (macOS
default `/usr/bin/openssl`) and OpenSSL 1.1.1+, so it is the most portable.

```sh
mkdir -p certs

cat > certs/openssl.cnf <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = excalidash.local
O = ExcaliDash Dev

[v3]
basicConstraints = CA:TRUE
keyUsage = keyCertSign, digitalSignature, nonRepudiation, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt

[alt]
DNS.1 = localhost
DNS.2 = excalidash.local
IP.1 = 127.0.0.1
# commented out as optional
# IP.2 = ${LAN_IP}
EOF

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout certs/privkey.pem \
  -out certs/fullchain.pem \
  -config certs/openssl.cnf

# DER copy for device trust stores (browsers/phones):
openssl x509 -in certs/fullchain.pem -outform der -out certs/excalidash-pwa.cer
```

Verify it matches the dev cert's shape:

```sh
openssl x509 -in certs/fullchain.pem -noout -subject -issuer
# subject=CN=excalidash.local, O=ExcaliDash Dev
# issuer=CN=excalidash.local, O=ExcaliDash Dev  (self-signed)

openssl x509 -in certs/fullchain.pem -noout -text \
  | grep -A1 "Basic Constraints\|Key Usage\|Subject Alternative Name"
# Basic Constraints: CA:TRUE
# Key Usage: Digital Signature, Non Repudiation, Key Encipherment, Certificate Sign
# Subject Alternative Name: DNS:localhost, DNS:excalidash.local, IP:127.0.0.1, IP:<your LAN IP>
```

> Regenerate whenever your Wi-Fi/LAN IP changes so the SAN still matches.
> On OpenSSL 1.1.1+ (e.g. `brew install openssl`) you can instead use the one-liner
> form, but it does **not** work with macOS's default LibreSSL:
> ```sh
> openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
>   -keyout certs/privkey.pem -out certs/fullchain.pem \
>   -subj "/CN=excalidash.local/O=ExcaliDash Dev" \
>   -addext "basicConstraints=CA:TRUE" \
>   -addext "keyUsage=keyCertSign,digitalSignature,nonRepudiation,keyEncipherment" \
>   -addext "extendedKeyUsage=serverAuth" \
>   -addext "subjectAltName=DNS:localhost,DNS:excalidash.local,IP:127.0.0.1,IP:${LAN_IP}" \
> && openssl x509 -in certs/fullchain.pem -outform der -out certs/excalidash-pwa.cer
> ```

### Option C — `mkcert` (host-only trust; extra steps for mobile)

`mkcert` auto-trusts the site on the *machine that runs it* (no warnings, no
`.cer` install needed there), which is convenient for desktop-only testing. But
for **mobile / PWA** you must install mkcert's **root CA** on each device (a leaf
cert cannot be fully trusted on iOS), so the self-signed CA above is simpler for
the "install on my phone" use case.

```sh
mkcert -install                                   # one-time, trusts the CA on this host
mkdir -p certs
mkcert -cert-file certs/fullchain.pem -key-file certs/privkey.pem \
  excalidash.local localhost 127.0.0.1 ::1
# For mobile: export mkcert's root CA as DER and install THAT on your devices:
mkcert -CAROOT                                    # prints the folder holding rootCA.pem
openssl x509 -in "$(mkcert -CAROOT)/rootCA.pem" -outform der -out certs/excalidash-pwa.cer
```

> Keep `certs/` out of version control — it is git-ignored (see `.gitignore`).

---

## 3. Run the app with custom SSL

Generate the certs first (step 2), then:

```sh
# Set required secrets (any long random strings):
export JWT_SECRET=$(openssl rand -hex 32)
export CSRF_SECRET=$(openssl rand -base64 32)

docker compose -f docker-compose.prod.ssl.yml up -d
```

Or via the Makefile shortcuts:

```sh
make ssl-up     # docker compose -f docker-compose.prod.ssl.yml up -d
make ssl-logs   # follow logs
make ssl-ps     # status
make ssl-down   # stop
```

Then open:

- `https://excalidash.local:6767`  (from any device on the same Wi-Fi, if Bonjour works)
- `https://localhost:6767`         (on the host running the stack)

To pull your published images instead of building locally, set the image vars
before bringing the stack up:

```sh
docker compose -f docker-compose.prod.ssl.yml pull
docker compose -f docker-compose.prod.ssl.yml up -d
```

---

## 4. Install and trust the certificate on your devices

Until `excalidash-pwa.cer` is trusted on a device, that device's browser will
show a "not private / not trusted" warning, and on iOS **Add to Home Screen will
not create a standalone PWA** (the service worker also refuses to register for
untrusted HTTPS origins, so offline breaks too). Install it once per device.

> The Docker container does **not** serve `/excalidash-pwa.cer` (only the Vite dev
> server does). Transfer the `certs/excalidash-pwa.cer` file to the device —
> AirDrop, a USB cable, email, or a cloud drive all work.

### iOS (iPhone / iPad) — two steps, both required

**4a. Install the profile:**
1. AirDrop `certs/excalidash-pwa.cer` to the iPhone (or email/iCloud Drive it
   over). Tap the received file → **Install Profile**.
2. **Settings → General → VPN & Device Management** → under "Downloaded Profile"
   tap **ExcaliDash Dev** → **Install** (top-right), enter passcode, confirm
   **Install** again.

**4b. Enable full trust (REQUIRED, or Safari keeps warning):**
1. **Settings → General → About → Certificate Trust Settings**.
2. Under "Enable full trust for root certificates", turn **ON** the toggle for
   **ExcaliDash Dev**.
3. Confirm the warning with **Continue**.

Without 4b, Safari still warns and the PWA will not install as standalone. This
is exactly why the cert is a CA (`CA:TRUE`) — iOS only offers this toggle for CAs.

### macOS

1. Double-click `excalidash-pwa.cer` → **Keychain Access** → add to the
   **System** (or **login**) keychain.
2. Find the **ExcaliDash Dev** cert, double-click it, expand **Trust**, set
   "When using this certificate" to **Always Trust**, close and authenticate.

Or from the terminal (needs admin):

```sh
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain certs/excalidash-pwa.cer
```

### Windows

1. Double-click `excalidash-pwa.cer` → **Install Certificate** → **Local
   Machine** (needs admin).
2. Choose **Place all certificates in the following store** → **Trusted Root
   Certification Authorities** → **Next** → **Finish**.

### Android

1. Copy `excalidash-pwa.cer` onto the phone.
2. **Settings → Security → Encryption & credentials → Install a certificate →
   CA certificate** (menu names vary by vendor; on Pixel it is under *More
   security settings*). Confirm the warning and select the file.
3. Chrome on Android honors user-installed CAs for browsing and PWA install.

After trusting, reload `https://excalidash.local:6767` — there should be **no**
certificate warning — then **Add to Home Screen** from the browser to get the
standalone PWA.

---

## 5. Bonjour / mDNS discovery (`excalidash.local`)

### Linux (native Docker)

The `avahi` sidecar in `docker-compose.prod.ssl.yml` uses `network_mode: host` to
broadcast on the host Wi-Fi interface. Nothing extra to do — bring the stack up
and `excalidash.local:6767` appears via Bonjour on other devices on the same LAN.

Verify from another machine:

```sh
dns-sd -B _https._tcp            # macOS
avahi-browse -t _https._tcp      # Linux
```

### macOS / Windows (Docker Desktop)

Docker Desktop does not forward mDNS multicast to the host Wi-Fi, so the avahi
sidecar cannot advertise there. Run the host-level helper in a separate
terminal alongside the stack:

```sh
make bonjour
# or: ./scripts/register-bonjour.sh
# Ctrl+C to stop advertising
```

This uses the built-in `dns-sd` on macOS (`avahi-publish` on Linux) to register
`excalidash.local` as `_https._tcp` on port 6767. Keep the terminal open while you
want the service advertised.

### Custom port

```sh
PORT=8443 ./scripts/register-bonjour.sh
```

---

## 6. Build and push the PWA images

The publisher is `scripts/publish-docker-pwa.sh`. It builds both images with
`docker buildx` (multi-arch `linux/amd64,linux/arm64` by default) and pushes
them to your registry account as:

```
<DOCKER_USERNAME>/excalidash-pwa-backend:<VERSION>
<DOCKER_USERNAME>/excalidash-pwa-frontend:<VERSION>
```

`<VERSION>` comes from the `VERSION` file (or an argument). When pushing it also
tags `:latest`.

### Build only (no push, for local testing)

```sh
make pwa-build
# or: ./scripts/publish-docker-pwa.sh --no-push
```

### Build and push to a public registry (e.g. Docker Hub)

```sh
export DOCKER_USERNAME=yourhubname      # required
docker login                            # one-time
make pwa-push
# or pin a version:
make pwa-release VERSION=1.2.3
```

Example resulting tags (with `DOCKER_USERNAME=yourhubname`):

```
yourhubname/excalidash-pwa-backend:0.5.1
yourhubname/excalidash-pwa-backend:latest
yourhubname/excalidash-pwa-frontend:0.5.1
yourhubname/excalidash-pwa-frontend:latest
```

---

## 7. Files added / changed

| File | Purpose |
|------|---------|
| `frontend/nginx.ssl.conf.template` | HTTPS nginx config (443 + 80→443 redirect) |
| `frontend/docker-entrypoint.sh` | picks SSL template when certs present |
| `frontend/Dockerfile` | copies SSL template, `EXPOSE 80 443` |
| `frontend/scripts/generate-dev-cert.mjs` | dev-server cert generator (mirrors the recipe in §2) |
| `scripts/publish-docker-pwa.sh` | build + push PWA images under `excalidash-pwa` |
| `docker/avahi/Dockerfile` | avahi mDNS advertiser sidecar |
| `docker/avahi/avahi-daemon.conf` | advertises `excalidash.local` |
| `docker/avahi/services/excalidash.service` | `_https._tcp` service record on port 6767 |
| `docker-compose.prod.ssl.yml` | SSL stack: mounts `./certs/`, host port 6767, Bonjour sidecar |
| `scripts/register-bonjour.sh` | host-level Bonjour fallback (macOS) |
| Makefile | `pwa-build`, `pwa-push`, `pwa-release`, `ssl-*`, `bonjour` |
