# ExcaliDash with Custom SSL + Bonjour Discovery

This guide explains how to build and publish the ExcaliDash **PWA** images
(custom-SSL capable), generate your own TLS certificates, run the stack over
HTTPS, and advertise it as `excalidash.local` on the local Wi-Fi via Bonjour/mDNS.

The standard images (`pavlobuidenkov/excalidash-pwa-*`) remain unchanged. The PWA images
are a separate image set published under the `excalidash-pwa` name.

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

## 2. Generate your SSL certificates

The compose file expects two files **in the same folder as
`docker-compose.prod.ssl.yml`**:

```
certs/fullchain.pem   # certificate chain
certs/privkey.pem     # unencrypted private key
```

These must be valid for the host you will connect to. For `excalidash.local`
include the hostname in the certificate (SAN). Two options:

### Option A — `mkcert` (recommended, trusted on your own machines)

```sh
# one-time: install the local CA into your trust store
mkcert -install

cd <folder that will hold docker-compose.prod.ssl.yml>
mkdir -p certs
mkcert -cert-file certs/fullchain.pem -key-file certs/privkey.pem \
  excalidash.local localhost 127.0.0.1 ::1
```

### Option B — `openssl` (self-signed; browsers will warn)

```sh
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/privkey.pem \
  -out certs/fullchain.pem \
  -subj "/CN=excalidash.local" \
  -addext "subjectAltName=DNS:excalidash.local,DNS:localhost,IP:127.0.0.1"
```

> Keep `certs/` out of version control — it is git-ignored (see `.gitignore`).
## 3. Build and push the PWA images

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

## 4. Run the app with custom SSL

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

## 6. Files added / changed

| File | Purpose |
|------|---------|
| `frontend/nginx.ssl.conf.template` | HTTPS nginx config (443 + 80→443 redirect) |
| `frontend/docker-entrypoint.sh` | picks SSL template when certs present |
| `frontend/Dockerfile` | copies SSL template, `EXPOSE 80 443` |
| `scripts/publish-docker-pwa.sh` | build + push PWA images under `excalidash-pwa` |
| `docker/avahi/Dockerfile` | avahi mDNS advertiser sidecar |
| `docker/avahi/avahi-daemon.conf` | advertises `excalidash.local` |
| `docker/avahi/services/excalidash.service` | `_https._tcp` service record on port 6767 |
| `docker-compose.prod.ssl.yml` | SSL stack: mounts `./certs/`, host port 6767, Bonjour sidecar |
| `scripts/register-bonjour.sh` | host-level Bonjour fallback (macOS) |
| Makefile | `pwa-build`, `pwa-push`, `pwa-release`, `ssl-*`, `bonjour` |
