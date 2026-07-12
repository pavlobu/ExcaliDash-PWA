#!/bin/sh
# Make `excalidash.local` resolvable from other devices on the same Wi-Fi/LAN
# (iOS Safari, Android, other laptops) by publishing an mDNS A record from the
# host machine.
#
# WHY THIS IS NEEDED (macOS / Windows, Docker Desktop)
#   The `avahi` sidecar in docker-compose.prod.ssl.yml uses host networking, but
#   Docker Desktop runs containers in a VM whose mDNS multicast never reaches the
#   host's real Wi-Fi interface. So phones on the same Wi-Fi never see avahi's
#   answer and `excalidash.local` does not resolve there — only the host can reach
#   it (and even there it resolves to the Docker VM IP, not the Wi-Fi IP).
#   This script publishes the A record on the host's actual Wi-Fi interface so
#   every device on the LAN can resolve `excalidash.local` -> your Wi-Fi IP.
#
# WHY THIS SUPERSEDES `dns-sd -R`
#   `dns-sd -R` only registers a _https._tcp *service* (browseable via
#   `dns-sd -B`), it does NOT publish a hostname A record, so Safari still cannot
#   resolve `excalidash.local`. `dns-sd -P` registers the service AND the host's
#   A record, which is what makes the name resolve.
#
# NETWORK-INDEPENDENT
#   The LAN IP is auto-detected at startup, so this works on any Wi-Fi or when the
#   machine acts as a hotspot for the phone. If you switch networks, just restart
#   the script (Ctrl+C and re-run) so it re-detects the current IP.
#
# Usage:
#   ./scripts/register-bonjour.sh            # excalidash.local:6767, auto IP
#   PORT=8443 ./scripts/register-bonjour.sh   # custom port
#   MDNS_HOST=myhost.local ./scripts/register-bonjour.sh
#   LAN_IP=192.168.1.5 ./scripts/register-bonjour.sh   # override detection

NAME="${NAME:-ExcaliDash}"
# NOTE: do not use $HOSTNAME — it is an auto-set shell variable holding the
# machine's real hostname, which would shadow the default below.
MDNS_HOST="${MDNS_HOST:-excalidash.local}"
PORT="${PORT:-6767}"

# --- Detect the host's current LAN IPv4 (non-loopback) ----------------------
if [ -z "$LAN_IP" ]; then
    if command -v ipconfig >/dev/null 2>&1; then
        # macOS: en0 is Wi-Fi on most Macs, en1 on some
        LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
    fi
    if [ -z "$LAN_IP" ] && command -v hostname >/dev/null 2>&1; then
        # Linux: first non-loopback IPv4
        LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
fi

if [ -z "$LAN_IP" ]; then
    echo "ERROR: could not detect a LAN IPv4 address."
    echo "Connect to Wi-Fi/Ethernet first, or set it explicitly:"
    echo "  LAN_IP=192.168.1.5 $0"
    exit 1
fi

echo "Publishing mDNS A record:"
echo "  ${MDNS_HOST} -> ${LAN_IP}   (_https._tcp :${PORT})"
echo "Keep this terminal open. Ctrl+C to stop advertising."
echo "If you switch Wi-Fi / turn on a hotspot, re-run this script to re-detect the IP."

if command -v dns-sd >/dev/null 2>&1; then
    # macOS: -P registers the service AND the host's A record (name resolves).
    exec dns-sd -P "$NAME" _https._tcp local "$PORT" "$MDNS_HOST" "$LAN_IP" path=/
elif command -v avahi-publish >/dev/null 2>&1; then
    # Linux: publish the A record (hostname -> IP) so the name resolves, plus the
    # service. On Linux the avahi sidecar (compose, host networking) already does
    # this automatically; this script is a host-level fallback.
    avahi-publish -a -R "$MDNS_HOST" "$LAN_IP" &
    A_PID=$!
    avahi-publish -s "$NAME" _https._tcp "$PORT" "path=/" &
    S_PID=$!
    trap 'kill $A_PID $S_PID 2>/dev/null' INT TERM
    wait
else
    echo "ERROR: no Bonjour publisher found."
    echo "macOS has 'dns-sd' built in. On Linux install 'avahi-utils'."
    exit 1
fi
