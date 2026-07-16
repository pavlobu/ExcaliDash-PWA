# ExcaliDash with Custom SSL + Bonjour Discovery

This guide explains how to generate your own TLS certificates, run the
ExcaliDash **PWA** stack over HTTPS, and — just as importantly — produce the
`excalidash-pwa.cer` file you install on your **browsers and mobile devices** as a
trusted certificate so the PWA installs as a standalone app with no security
warnings.

The certificate is **network-independent**: it lists only the hostname
`excalidash.local` (no LAN IP), so the same cert works on any Wi-Fi and when the
machine acts as a hotspot. The hostname is resolved per-network via mDNS, so you
generate the cert once and never regenerate it when you switch networks.

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
- **Bonjour / mDNS**: `excalidash.local` is resolved per-network via mDNS so the
  hostname-only certificate works on any Wi-Fi or hotspot. On **Linux** an
  `avahi` sidecar (opt-in via the `mdns` compose profile) broadcasts on the real
  Wi-Fi. On **macOS/Windows (Docker Desktop)** the VM cannot bridge mDNS to the
  host Wi-Fi, so run `scripts/register-bonjour.sh` on the host — it publishes the
  A record on the real Wi-Fi interface (see §5).

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
- The Subject Alternative Name (SAN) is **hostname-only**: `localhost`,
  `excalidash.local`, `127.0.0.1`. It deliberately does **not** pin a LAN IP, so
  the **same cert works on any Wi-Fi or when the machine acts as a hotspot**.
  Devices connect by the hostname `excalidash.local`, which mDNS resolves to
  whatever IP the host currently has on that network (see §5). The certificate
  only has to match the *name*, never the IP, so you generate it once and never
  regenerate it when you switch networks.
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

### Auto-generation (zero config)

If `certs/` is missing or does **not** contain both `fullchain.pem` **and**
`privkey.pem`, bringing the stack up auto-generates a self-signed CA certificate
for you — no manual step required:

```sh
docker compose -f docker-compose.prod.ssl.yml pull
docker compose -f docker-compose.prod.ssl.yml up -d
```

A one-shot `cert-init` service (it reuses the backend image, which ships with
`openssl`) writes the three files above into `./certs/` before the frontend
starts. The generated cert is a self-signed CA (`CA:TRUE`) with
`CN=excalidash.local, O=ExcaliDash Dev` and a **hostname-only** SAN
(`localhost`, `excalidash.local`, `127.0.0.1`) — i.e. the recipe below. No LAN
IP is included, so the cert is valid on every network.

### Auto-renewal on every start

`cert-init` runs on **every** `docker compose ... up -d` (compose re-runs an
exited one-shot service each time). On each run it checks the existing cert and
regenerates it only when needed, so the stack never silently ships an expiring
certificate:

- **Missing** `fullchain.pem` or `privkey.pem` → generate.
- **Expires within 7 days** (checked via `openssl x509 -checkend 604800`) →
  generate a fresh 825-day cert.
- **Valid for ≥ 7 more days** → leave the existing cert untouched (so you keep
  the cert your devices already trust).

New certs are 825 days valid (the same lifespan used by §2 below). Because a
regenerated cert is a *new* self-signed cert, you must re-install
`certs/excalidash-pwa.cer` on your devices after a renewal (see §4) — this only
happens roughly every 2.25 years, or sooner if you deleted `./certs/`.

Existing certs are never overwritten: if both `fullchain.pem` and `privkey.pem`
are present and still valid for ≥ 7 days, `cert-init` skips generation.

> The cert is **network-independent** by design: it lists only the hostname
> `excalidash.local` (no LAN IP), so it works on any Wi-Fi and when the machine is
> a hotspot. The hostname is resolved per-network by mDNS (§5), so you do **not**
> need to regenerate the cert when your IP changes. You only regenerate if you
> want to customize the SAN (e.g. add a fixed IP for connecting by raw IP), or if
> the cert is near expiry.

### Manual generation (to customize the SAN)

Follow this if you want control over the SAN, or if `openssl` is unavailable to
the stack. The result is identical in shape to the auto-generated cert — a
hostname-only, network-independent self-signed CA. (Only add a LAN IP if you
specifically want to connect by raw IP; it is not needed for `excalidash.local`.)

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
# Optional: add a LAN IP ONLY if you connect by raw IP (not needed for
# excalidash.local, which is resolved by mDNS). Pinning an IP makes the cert
# network-specific, so it is off by default.
# IP.2 = 192.168.x.x
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
# Subject Alternative Name: DNS:localhost, DNS:excalidash.local, IP Address:127.0.0.1
```

> The cert is hostname-only, so you do **not** regenerate it when switching Wi-Fi
> / enabling a hotspot — `excalidash.local` follows you via mDNS (§5).
>
> On OpenSSL 1.1.1+ (e.g. `brew install openssl`; macOS's default LibreSSL does
> not support `-addext`) the equivalent one-liner is:
> ```sh
> openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
>   -keyout certs/privkey.pem -out certs/fullchain.pem \
>   -subj "/CN=excalidash.local/O=ExcaliDash Dev" \
>   -addext "basicConstraints=CA:TRUE" \
>   -addext "keyUsage=keyCertSign,digitalSignature,nonRepudiation,keyEncipherment" \
>   -addext "extendedKeyUsage=serverAuth" \
>   -addext "subjectAltName=DNS:localhost,DNS:excalidash.local,IP:127.0.0.1" \
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

Certs are auto-generated on first `up` if `./certs/` is missing (see §2
Auto-generation). You only need the manual steps in §2 to customize the SAN.

```sh
# Set required secrets (any long random strings):
export JWT_SECRET=$(openssl rand -hex 32)
export CSRF_SECRET=$(openssl rand -base64 32)

docker compose -f docker-compose.prod.ssl.yml pull
docker compose -f docker-compose.prod.ssl.yml up -d
```

> The compose project/group name is pinned to `excalidash-pwa` (top-level
> `name:` in the file), so the container group is always `excalidash-pwa`
> regardless of the folder you run it from. Note: changing the project name
> also renames the backend data volume (`excalidash-pwa_backend-data`); if you
> previously ran this stack from a differently-named folder, that old volume's
> data is not carried over.

Or via the Makefile shortcuts:

```sh
make ssl-up     # docker compose -f docker-compose.prod.ssl.yml up -d (auto-generates ./certs/ if missing)
make ssl-logs   # follow logs
make ssl-ps     # status
make ssl-down   # stop
```

Then open:

- `https://excalidash.local:6767`  (from any device on the same Wi-Fi, once mDNS is running — see §5)
- `https://localhost:6767`         (on the host running the stack)

> On macOS, `excalidash.local` will not resolve from your phone until you start
> the host mDNS responder (§5). On the host it may resolve to the Docker VM IP if
> the avahi sidecar is running — disable the `mdns` profile on macOS and use the
> host responder instead, so both host and phone resolve to the real Wi-Fi IP.

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

The certificate only lists the *hostname* `excalidash.local` (no IP), so for a
device to connect it must **resolve that name to the host's current IP on that
network**. That resolution happens via mDNS (Bonjour).

There are two parts:

1. **`excalidash-pwa-avahi` container** (beacon) — starts by default with the
   stack on **every OS** (it runs on the Docker bridge network, so it always
   shows up in Docker Desktop and stays healthy). A bridge cannot broadcast mDNS
   to the physical Wi-Fi, so the beacon alone does **not** make phones resolve the
   name — it just shows the stack is up.
2. **Host A-record advertiser** (required for Wi-Fi discovery) — publishes
   `excalidash.local` → your current Wi-Fi IP on the real interface, so every
   device on the LAN resolves the name. This is OS-specific (below) and is what
   actually makes `excalidash.local` work on phones.

> Why a host advertiser and not just the container? Docker Desktop runs containers
> in a VM whose mDNS multicast never reaches the host's real Wi-Fi, and
> `network_mode: host` there can even make the host resolve `excalidash.local` to
> the Docker VM IP (192.168.64.x), breaking access from the Mac itself. The avahi
> container therefore runs on the bridge (safe, always visible), and the host
> advertiser does the real Wi-Fi broadcast. On Linux desktops the host advertiser
> publishes through the local avahi daemon (`avahi-publish`).

### One command: `make local-up` (recommended)

`scripts/start-local.sh` brings up the SSL Docker stack (incl. the avahi beacon)
**and** installs the persistent host advertiser in one go:

```sh
make local-up     # or: ./scripts/start-local.sh
make local-status # stack + mDNS status
make local-logs   # follow logs
make local-down   # stop the stack and stop advertising
```

It installs a **persistent** host mDNS advertiser on every OS — a launchd
LaunchAgent on macOS (`RunAtLoad` + `KeepAlive`), a systemd user unit on Linux, a
hidden Startup-folder launcher on Windows. It starts at login, survives reboots,
and re-detects your IP if you switch Wi-Fi or toggle a hotspot. This is the fix
for *"excalidash.local worked during development but stopped after restarting the
computer"* — the old flow relied on a foreground `dns-sd` process in a terminal
that dies on reboot.

### Host advertiser (all OSes) — persistent install

```sh
make bonjour-install            # or: ./scripts/register-bonjour.sh install
make bonjour-status             # is it running?
make bonjour-restart            # re-detect IP after a network change / reload
make bonjour-uninstall          # remove it
```

- macOS: installs a launchd LaunchAgent (`~/Library/LaunchAgents/com.excalidash.mdns.plist`)
  with `RunAtLoad` + `KeepAlive`; logs at `~/Library/Logs/excalidash-mdns.log`.
- Linux: installs a systemd user unit (`excalidash-mdns.service`); publishes
  through the local avahi daemon via `avahi-publish`. (On a headless Linux box
  without systemd you can run `./scripts/register-bonjour.sh --daemon` from your
  own init/cron.)
- Windows: installs a hidden Startup-folder launcher (`dns-sd.exe` from Bonjour);
  install Bonjour first (it ships with iTunes / *Bonjour Print Services for
  Windows*).

Verify it is publishing (from another device or the host):

```sh
dns-sd -G v4 excalidash.local     # should show your Wi-Fi IP, TTL ~240
ping excalidash.local              # host: should resolve to the Wi-Fi IP, not 192.168.64.x
```

### Foreground (ad-hoc, must keep the terminal open)

```sh
make bonjour
# or: ./scripts/register-bonjour.sh
# Ctrl+C to stop advertising
```

This uses the built-in `dns-sd -P` on macOS (`avahi-publish` on Linux). It
**auto-detects your LAN IP at startup**, so it is network-independent — it works
on any Wi-Fi and when the machine is a hotspot. If you switch networks or turn the
hotspot on/off, just **re-run the script** (or use `make bonjour-restart`) so it
re-detects the new IP.

Verify it is publishing (from another device or the host):

```sh
dns-sd -G v4 excalidash.local     # should show your Wi-Fi IP, TTL ~240
ping excalidash.local              # host: should resolve to the Wi-Fi IP, not 192.168.64.x
```

> Why `dns-sd -P` and not `-R`? `dns-sd -R` only registers a *service*
> (browseable via `dns-sd -B`); it does **not** publish a hostname A record, so
> Safari still cannot resolve `excalidash.local`. `dns-sd -P` registers the
> service **and** the host's A record — that is what makes the name resolve. The
> old `register-bonjour.sh` used `-R`, which is why `excalidash.local` worked on
> the host but not on the iPhone.

### Custom port / hostname

```sh
PORT=8443 ./scripts/register-bonjour.sh
MDNS_HOST=myhost.local ./scripts/register-bonjour.sh
LAN_IP=192.168.1.5 ./scripts/register-bonjour.sh   # override auto-detection
```

---

## 6. Build and push the PWA images

The publisher is `scripts/publish-docker-pwa.sh`. It builds the frontend,
backend, and avahi (Bonjour/mDNS sidecar) images with `docker buildx` (multi-arch
`linux/amd64,linux/arm64` by default) and pushes them to your registry account as:

```
<DOCKER_USERNAME>/excalidash-pwa-backend:<VERSION>
<DOCKER_USERNAME>/excalidash-pwa-frontend:<VERSION>
<DOCKER_USERNAME>/excalidash-pwa-avahi:<VERSION>
```

`<VERSION>` comes from the `VERSION` file (or an argument). When pushing it also
tags `:latest`. The avahi image is pre-built and pulled by
`docker-compose.prod.ssl.yml`, so you do **not** need the `docker/avahi/` source
folder next to the compose file — just `pull` and `up -d`.

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
yourhubname/excalidash-pwa-avahi:0.5.1
yourhubname/excalidash-pwa-avahi:latest
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
| `docker-compose.prod.ssl.yml` | SSL stack: pinned project `excalidash-pwa`, mounts `./certs/`, host port 6767, `cert-init` auto-generates `./certs/` if missing and auto-renews when the cert expires within 7 days, `avahi` beacon (`excalidash-pwa-avahi`) starts by default on the bridge network on every OS (visible in Docker Desktop; bridge cannot reach Wi-Fi, so the host advertiser below does LAN resolution) |
| `scripts/register-bonjour.sh` | host-level mDNS responder (macOS/Windows/Linux): publishes an A record for `excalidash.local` on the real Wi-Fi via `dns-sd -P`/`avahi-publish`; `install`/`uninstall`/`status`/`restart` manage a persistent background service (launchd / systemd user unit / Windows Startup) that survives reboots; `--daemon` is an IP-change-aware supervisor; foreground mode still works ad-hoc |
| `scripts/start-local.sh` | one-command LAN launcher: brings up the SSL stack (`cert-init` auto-generates certs) AND ensures `excalidash.local` is advertised — avahi sidecar (`--profile mdns`) on Linux, persistent host advertiser on macOS/Windows |
| Makefile | `pwa-build`, `pwa-push`, `pwa-release`, `ssl-*`, `bonjour`, `bonjour-install/uninstall/status/restart`, `local-up/down/status/logs` |
