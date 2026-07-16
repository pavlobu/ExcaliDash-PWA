#!/bin/sh
# start-local.sh — one command to run ExcaliDash over HTTPS on the LAN as
# https://excalidash.local:6767, using the auto-generated self-signed cert.
#
# It combines two things that must both be present for `excalidash.local` to work
# from other devices on the same Wi-Fi:
#   1. The SSL Docker stack (docker-compose.prod.ssl.yml), whose `cert-init`
#      one-shot service auto-generates ./certs/ (fullchain.pem, privkey.pem,
#      excalidash-pwa.cer) on first run and renews it when near expiry. The
#      stack also starts the `excalidash-pwa-avahi` beacon container (bridge
#      network) so you always see the full stack in Docker Desktop.
#   2. mDNS / Bonjour A-record for `excalidash.local` on the real Wi-Fi:
#        A Docker bridge cannot broadcast mDNS to the physical Wi-Fi (multicast
#        does not cross the Docker NAT), so the HOST must publish the A record.
#        This script installs a persistent HOST advertiser on EVERY OS via
#        scripts/register-bonjour.sh install:
#          - macOS:    launchd LaunchAgent (RunAtLoad + KeepAlive)
#          - Linux:    systemd user unit (fallback to foreground note)
#          - Windows:  hidden Startup-folder launcher (needs Bonjour/dns-sd.exe)
#        It starts at login, survives reboots, and re-detects your IP if you
#        switch Wi-Fi / toggle a hotspot. This is the fix for "excalidash.local
#        worked during dev but stopped after restarting the computer".
#
# Usage:
#   ./scripts/start-local.sh            # bring the stack + mDNS up
#   ./scripts/start-local.sh --stop     # bring it down (and stop advertising)
#   ./scripts/start-local.sh --status   # show stack + mDNS status
#   ./scripts/start-local.sh --logs     # follow stack logs
#
# Env (optional): NAME, MDNS_HOST (default excalidash.local), PORT (default 6767),
#   plus any docker-compose.prod.ssl.yml vars (JWT_SECRET, CSRF_SECRET, ...).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.ssl.yml"
BONJOUR="$SCRIPT_DIR/register-bonjour.sh"

compose() {
    docker compose -f "$COMPOSE_FILE" "$@"
}

ensure_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "ERROR: docker is not installed / not on PATH." >&2
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        echo "ERROR: the Docker daemon is not running (start Docker Desktop / dockerd)." >&2
        exit 1
    fi
}

ensure_mdns() {
    # The avahi container runs on a bridge and cannot broadcast mDNS to the
    # physical Wi-Fi, so the HOST must publish the A record on every OS.
    if [ ! -x "$BONJOUR" ]; then
        echo "ERROR: $BONJOUR not found or not executable." >&2
        exit 1
    fi
    if "$BONJOUR" status >/dev/null 2>&1; then
        echo "mDNS: host advertiser already running."
    else
        echo "mDNS: installing persistent host advertiser (survives reboots)..."
        "$BONJOUR" install
        "$BONJOUR" status || true
    fi
}

stop_mdns() {
    if [ -x "$BONJOUR" ]; then
        "$BONJOUR" uninstall
    fi
}

cmd_up() {
    ensure_docker
    echo "Starting ExcaliDash (custom SSL) from $COMPOSE_FILE ..."
    # Pull is best-effort: continue if offline or using locally-built images.
    compose pull || echo "(pull skipped — using local images or offline)"
    compose up -d
    ensure_mdns
    echo ""
    echo "ExcaliDash is up:"
    echo "  https://excalidash.local:6767   (any device on the same Wi-Fi)"
    echo "  https://localhost:6767          (this machine)"
    echo ""
    echo "mDNS status:    $BONJOUR status"
    echo "mDNS restart:   $BONJOUR restart    (re-detect IP after a network change)"
    echo "Stack logs:     $0 --logs"
}

cmd_down() {
    ensure_docker
    echo "Stopping ExcaliDash (custom SSL) ..."
    compose down
    stop_mdns
    echo "Stopped. (certs in ./certs/ and the backend volume are preserved.)"
}

cmd_status() {
    ensure_docker
    echo "== Docker stack =="
    compose ps
    echo ""
    echo "== mDNS (host advertiser) =="
    if [ -x "$BONJOUR" ]; then
        "$BONJOUR" status || true
    else
        echo "$BONJOUR not found."
    fi
}

cmd_logs() {
    compose logs -f --tail=200
}

case "${1:-}" in
    --stop|-stop|down) cmd_down ;;
    --status|-status|status) cmd_status ;;
    --logs|-logs|logs) cmd_logs ;;
    --help|-h|help)
        sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    "") cmd_up ;;
    *)
        echo "Unknown argument: $1" >&2
        echo "Try: $0 --help" >&2
        exit 1
        ;;
esac
