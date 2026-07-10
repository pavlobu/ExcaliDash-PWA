# Local Dev PWA Testing over HTTPS with `excalidash.local`

iOS Safari only installs a website as a **standalone** PWA (Add to Home Screen → opens
without the Safari chrome) when the site is served over **HTTPS** with a certificate
the device trusts. `http://localhost` is a secure context for the browser, but
`Add to Home Screen` on iOS over plain HTTP (or a self-signed cert that is **not**
trusted) does **not** produce a standalone app — it just opens Safari.

This project's dev server now:

1. Generates a self-signed certificate for `localhost`, `127.0.0.1`,
   `excalidash.local`, and your Mac's LAN IP.
2. Runs a **Bonjour (mDNS) responder** so `excalidash.local` resolves to your Mac's
   LAN IP from any device on the same Wi-Fi.
3. Serves the Vite dev server over **HTTPS** on port `6767`.

The cert lives in `frontend/devcert/` (gitignored). Reuse it across runs; regenerate
when your Wi-Fi IP changes.

---

## 1. Start the dev server

From the repo root (or `frontend/`):

```bash
cd frontend
npm run dev
```

On first run this:

- creates `devcert/cert.pem`, `devcert/key.pem`, and `devcert/excalidash.cer` (DER, for iOS)
- starts the Bonjour responder for `excalidash.local`
- starts Vite over HTTPS at `https://excalidash.local:6767`

Expected output:

```
[dev-cert] LAN IP: 192.168.x.x
[dev-cert] Hostnames: localhost, excalidash.local, 127.0.0.1, 192.168.x.x
[dev-cert] DER:   .../excalidash.cer  (AirDrop this to your iPhone)
[mdns]   Bonjour responding: excalidash.local -> 192.168.x.x
  VITE vX.X  ready in XXX ms
  ➜  Local:   https://localhost:6767/
  ➜  Network: https://192.168.x.x:6767/
```

If the cert already exists it is reused. To force regeneration (e.g. after changing
Wi-Fi networks):

```bash
npm run cert        # regenerate cert only
# or
rm -rf devcert && npm run dev
```

The backend API proxy still works: `/api` and `/socket.io` proxy to
`http://localhost:8000` (override with `VITE_DEV_BACKEND_URL`).

---

## 2. Get the certificate onto your iPhone

Two options.

### Option A — AirDrop (fastest)

1. In Finder, go to `frontend/devcert/excalidash.cer`.
2. AirDrop it to your iPhone.
3. On the iPhone, tap the AirDrop notification → **Install Profile**.

### Option B — Download from the dev server

Safari shows a cert warning (expected — not trusted yet), but you can still proceed
and download the file:

1. On the iPhone, open `https://excalidash.local:6767/excalidash.cer`
   (Safari will warn the connection is not private → **Show Details** →
   **visit this website** → proceed).
2. The `.cer` downloads → tap it → **Install Profile**.

> The `.cer` is also served by the dev server because Vite serves files in `public/`.
> We copy it there automatically: see `npm run cert` which writes to `devcert/`.
> If Safari can't fetch it directly, AirDrop is the reliable fallback.

---

## 3. Install and trust the profile on iOS

Apple requires **two** steps: install the profile, then explicitly enable trust.

### Step 3a — Install the profile

1. **Settings → General → VPN & Device Management**.
2. Under "Downloaded Profile", tap **ExcaliDash Dev** (or the profile you just added).
3. Tap **Install** (top-right), enter your passcode, confirm **Install** again.

### Step 3b — Enable full trust (REQUIRED for HTTPS / PWA)

1. **Settings → General → About → Certificate Trust Settings**.
2. Under "Enable full trust for root certificates", turn **ON** the toggle for
   **ExcaliDash Dev**.
3. Confirm the warning with **Continue**.

Without Step 3b, Safari will keep showing the "not trusted" warning and
Add to Home Screen will **not** behave as a standalone PWA.

---

## 4. Add to Home Screen and test the PWA

> **IMPORTANT — read before re-adding.** iOS caches the Add-to-Home-Screen metadata
> (manifest + meta tags) **at the moment the icon is created**. Any icon added
> *before* the manifest was served correctly will keep opening in the browser
> (with URL bar) forever, no matter what you fix server-side. You **must** remove
> the old icon and re-add it. See troubleshooting below.

1. On the iPhone (same Wi-Fi as the Mac), open **Safari** (not Chrome) and go to
   `https://excalidash.local:6767`.
   - There should be **no** certificate warning now (trusted in Step 3).
2. Tap the **Share** button (square with up arrow).
3. Scroll down → **Add to Home Screen**.
4. Tap **Add**.

Now tap the new "ExcaliDash" icon on the home screen. It should open
**without the Safari address bar / chrome** — a standalone PWA window.

### If it still opens in Safari (with URL bar)

- **Remove the old home screen icon first** (long-press → Remove App), then
  re-add from Safari. This is the #1 cause. iOS does not re-read manifest/meta
  for an existing web clip.
- **Use Safari, not Chrome.** A home-screen shortcut created from iOS Chrome
  opens in Chrome with browser bars and often ignores `apple-mobile-web-app-capable`.
  Only Safari creates a true standalone web clip.
- Confirm the profile is **fully trusted** (Step 3b, not just installed):
  Settings → General → About → Certificate Trust Settings → toggle ON.
- Confirm iPhone and Mac are on the **same Wi-Fi** and `excalidash.local` resolves
  (Safari must load the page with **no cert warning**).
- Confirm the manifest is served: in Safari, open
  `https://excalidash.local:6767/manifest.webmanifest` — it should show JSON
  with `"display":"standalone"`, not the app HTML. (If it shows HTML, the dev
  server's `devOptions` is not active — restart `npm run dev`.)
- After removing the old icon, **close Safari fully** (swipe it away from the app
  switcher) before re-adding, so Safari re-fetches the page fresh.

---

## 5. Backend during PWA testing

The frontend dev server proxies `/api` and `/socket.io` to the backend. Start it
separately so login / drawings / collaboration work on the phone:

```bash
cd backend
cp .env.example .env
npx prisma generate && npx prisma db push
npm run dev
```

The phone hits `https://excalidash.local:6767/api/...`, which Vite proxies to
`http://localhost:8000` on the Mac.

### Backend `.env` for local HTTPS dev

The backend must **not** redirect HTTP→HTTPS in local dev, because the Vite proxy
talks HTTP to the backend. Set in `backend/.env`:

```
ENFORCE_HTTPS_REDIRECT=false
FRONTEND_URL=http://localhost:6767,http://192.168.1.46:6767,https://excalidash.local:6767
```

(The `https://excalidash.local:6767` entry lets the backend accept CSRF/CORS
from the HTTPS frontend origin.)

### HTTP→HTTPS redirect in dev

The dev server also starts an HTTP listener on port `6768` that redirects all
requests to `https://excalidash.local:6767`. If someone types
`http://excalidash.local:6768` in the browser, they are redirected to the HTTPS
URL. Override the redirect port with `DEV_HTTP_PORT=xxxx`.

---

## How it works (reference)

| Piece | File | Purpose |
|-------|------|---------|
| Cert generation | `scripts/generate-dev-cert.mjs` | Self-signed cert (825 days), SANs for `localhost`/`excalidash.local`/LAN IP, DER `.cer` for iOS |
| Bonjour / mDNS | `scripts/dev-mdns.mjs` | Answers `A` queries for `excalidash.local` → Mac LAN IP |
| Orchestrator | `scripts/dev-server.mjs` | Generates cert → starts mDNS → spawns Vite; cleans up on exit |
| HTTPS wiring | `vite.config.ts` | Loads `devcert/cert.pem`+`key.pem` into `server.https`, binds `0.0.0.0:6767` |
| Ignore | `frontend/.gitignore` | `devcert` never committed |

The Bonjour responder advertises the `excalidash.local` hostname via mDNS so the
iPhone resolves it without DNS setup. It answers `A` record queries; it does not
publish a `_http._tcp` service (not needed — Safari resolves the hostname directly).
