#!/bin/sh
# Register https://excalidash.local:6767 on the local Wi-Fi via Bonjour/mDNS.
#
# Use this on macOS (or any host where the Docker avahi sidecar cannot reach
# the host Wi-Fi multicast). Run it in a terminal alongside the compose stack;
# keep it running while you want the service advertised. Stop with Ctrl+C.
#
# Usage:
#   ./scripts/register-bonjour.sh            # uses excalidash.local:6767
#   PORT=8443 ./scripts/register-bonjour.sh  # custom port

NAME="excalidash"
PORT="${PORT:-6767}"

if [ -n "$1" ]; then
    NAME="$1"
fi

if command -v dns-sd >/dev/null 2>&1; then
    echo "Registering Bonjour service (macOS dns-sd):"
    echo "  ${NAME}.local  _https._tcp :${PORT}"
    exec dns-sd -R ExcaliDash _https._tcp . "${PORT}" path=/
elif command -v avahi-publish >/dev/null 2>&1; then
    echo "Registering Bonjour service (avahi-publish):"
    echo "  ${NAME}.local  _https._tcp :${PORT}"
    exec avahi-publish -s "${NAME}" _https._tcp "${PORT}" path=/
else
    echo "ERROR: no Bonjour publisher found."
    echo "macOS has 'dns-sd' built in. On Linux install 'avahi-utils'."
    exit 1
fi
