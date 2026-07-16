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
# NETWORK-INDEPENDENT + PERSISTENT
#   The LAN IP is auto-detected, so this works on any Wi-Fi or when the machine
#   acts as a hotspot. In `--daemon` mode the IP is re-checked periodically and
#   the advertiser is restarted if it changed (Wi-Fi switch / hotspot toggle).
#   `install` registers a persistent background service (launchd on macOS, a
#   systemd user unit on Linux, a Startup-folder launcher on Windows) so the
#   advertiser starts at login and survives reboots — no need to keep a terminal
#   open. This is the fix for "excalidash.local worked during dev but stopped
#   after restarting the computer".
#
# Usage:
#   ./scripts/register-bonjour.sh                # foreground (Ctrl+C to stop)
#   ./scripts/register-bonjour.sh --daemon       # background supervisor (re-detects IP)
#   ./scripts/register-bonjour.sh install        # install + start persistent service
#   ./scripts/register-bonjour.sh uninstall      # remove persistent service
#   ./scripts/register-bonjour.sh status         # is the persistent advertiser running?
#   ./scripts/register-bonjour.sh restart        # reload the persistent advertiser
#
#   PORT=8443 ./scripts/register-bonjour.sh
#   MDNS_HOST=myhost.local ./scripts/register-bonjour.sh
#   LAN_IP=192.168.1.5 ./scripts/register-bonjour.sh   # pin IP (disables re-detect)

NAME="${NAME:-ExcaliDash}"
# NOTE: do not use $HOSTNAME — it is an auto-set shell variable holding the
# machine's real hostname, which would shadow the default below.
MDNS_HOST="${MDNS_HOST:-excalidash.local}"
PORT="${PORT:-6767}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/register-bonjour.sh"
OS="$(uname -s)"

# If the user pinned an IP, freeze it (disable runtime re-detection).
IP_FIXED=0
FIXED_IP=""
if [ -n "${LAN_IP:-}" ]; then
    IP_FIXED=1
    FIXED_IP="$LAN_IP"
fi

log() {
    printf '[excalidash-mdns %s] %s\n' "$(date '+%H:%M:%S' 2>/dev/null || date)" "$1"
}

# --- Detect the host's current LAN IPv4 (non-loopback) ----------------------
detect_lan_ip() {
    if [ "$IP_FIXED" = "1" ]; then
        LAN_IP="$FIXED_IP"
        return 0
    fi
    NEW_IP=""
    case "$OS" in
        Darwin)
            NEW_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
            [ -z "$NEW_IP" ] && NEW_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
            ;;
        Linux)
            if command -v hostname >/dev/null 2>&1; then
                NEW_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
            fi
            if [ -z "$NEW_IP" ] && command -v ip >/dev/null 2>&1; then
                NEW_IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4,a,"/"); print a[1]; exit}')"
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            if command -v powershell.exe >/dev/null 2>&1; then
                NEW_IP="$(powershell.exe -NoProfile -Command \
                    "(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias Wi-Fi -ErrorAction SilentlyContinue).IPAddress" \
                    2>/dev/null | tr -d '\r' | awk '{print $1}')"
            fi
            if [ -z "$NEW_IP" ]; then
                NEW_IP="$(ipconfig.exe 2>/dev/null | tr -d '\r' | \
                    awk '/IPv4/{split($0,a,":"); gsub(/^ +/,"",a[2]); if (a[2] !~ /^127\./ && a[2] ~ /^[0-9]/) {print a[2]; exit}}')"
            fi
            ;;
    esac
    [ -n "$NEW_IP" ] && LAN_IP="$NEW_IP"
}

# --- Advertiser binary probe ------------------------------------------------
advertiser_available() {
    case "$OS" in
        Darwin) command -v dns-sd >/dev/null 2>&1 ;;
        Linux) command -v avahi-publish >/dev/null 2>&1 ;;
        MINGW*|MSYS*|CYGWIN*) command -v dns-sd.exe >/dev/null 2>&1 ;;
        *) false ;;
    esac
}

# Start the mDNS advertiser in the BACKGROUND. Sets ADVPIDS (space-separated).
start_advertiser_bg() {
    ADVPIDS=""
    case "$OS" in
        Darwin)
            dns-sd -P "$NAME" _https._tcp local "$PORT" "$MDNS_HOST" "$LAN_IP" path=/ &
            ADVPIDS="$!"
            ;;
        Linux)
            avahi-publish -a -R "$MDNS_HOST" "$LAN_IP" &
            A_PID=$!
            avahi-publish -s "$NAME" _https._tcp "$PORT" "path=/" &
            S_PID=$!
            ADVPIDS="$A_PID $S_PID"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            dns-sd.exe -P "$NAME" _https._tcp local "$PORT" "$MDNS_HOST" "$LAN_IP" path=/ &
            ADVPIDS="$!"
            ;;
        *)
            log "ERROR: unsupported OS '$OS'"
            exit 1
            ;;
    esac
}

# --- Foreground mode (default; backward compatible) -------------------------
run_foreground() {
    detect_lan_ip
    if [ -z "$LAN_IP" ]; then
        echo "ERROR: could not detect a LAN IPv4 address." >&2
        echo "Connect to Wi-Fi/Ethernet first, or set it explicitly:" >&2
        echo "  LAN_IP=192.168.1.5 $0" >&2
        exit 1
    fi
    echo "Publishing mDNS A record:"
    echo "  ${MDNS_HOST} -> ${LAN_IP}   (_https._tcp :${PORT})"
    echo "Keep this terminal open. Ctrl+C to stop advertising."
    echo "Tip: for a persistent background advertiser that survives reboots, run:"
    echo "  $0 install"
    case "$OS" in
        Darwin)
            exec dns-sd -P "$NAME" _https._tcp local "$PORT" "$MDNS_HOST" "$LAN_IP" path=/
            ;;
        Linux)
            avahi-publish -a -R "$MDNS_HOST" "$LAN_IP" &
            A_PID=$!
            avahi-publish -s "$NAME" _https._tcp "$PORT" "path=/" &
            S_PID=$!
            trap 'kill $A_PID $S_PID 2>/dev/null' INT TERM
            wait
            ;;
        MINGW*|MSYS*|CYGWIN*)
            exec dns-sd.exe -P "$NAME" _https._tcp local "$PORT" "$MDNS_HOST" "$LAN_IP" path=/
            ;;
        *)
            echo "ERROR: unsupported OS '$OS'" >&2
            exit 1
            ;;
    esac
}

# --- Daemon supervisor mode (background, IP-change aware) --------------------
run_daemon() {
    if ! advertiser_available; then
        log "ERROR: no mDNS publisher found for $OS."
        log "  macOS: 'dns-sd' is built in. Linux: install 'avahi-utils'."
        log "  Windows: install Bonjour (ships with iTunes / Bonjour Print Services)."
        exit 1
    fi
    POLL_SEC="${POLL_SEC:-20}"
    ADVPIDS=""
    CURRENT_IP=""

    stop_adv() {
        for p in $ADVPIDS; do kill "$p" 2>/dev/null; done
        ADVPIDS=""
    }
    cleanup() { stop_adv; }
    trap cleanup INT TERM
    # On unexpected child death, reap silently.
    trap ':' HUP

    log "supervisor started (host=${MDNS_HOST} port=${PORT} poll=${POLL_SEC}s$( [ "$IP_FIXED" = "1" ] && echo " ip=${FIXED_IP}(fixed)" || echo ""))"
    while :; do
        detect_lan_ip
        if [ -z "$LAN_IP" ]; then
            log "no LAN IPv4 detected; will retry in ${POLL_SEC}s"
            stop_adv
            CURRENT_IP=""
            sleep "$POLL_SEC"
            continue
        fi
        if [ "$LAN_IP" != "$CURRENT_IP" ]; then
            log "advertising ${MDNS_HOST} -> ${LAN_IP}:${PORT} (was ${CURRENT_IP:-none})"
            stop_adv
            # let the OS drop the stale record before re-publishing
            sleep 1
            start_advertiser_bg
            CURRENT_IP="$LAN_IP"
        fi
        sleep "$POLL_SEC"
    done
}

# --- Persistent service: macOS (launchd LaunchAgent) ------------------------
macos_domain() { echo "gui/$(id -u)"; }

install_macos() {
    LA_DIR="$HOME/Library/LaunchAgents"
    LOG_DIR="$HOME/Library/Logs"
    mkdir -p "$LA_DIR" "$LOG_DIR"
    PLIST="$LA_DIR/com.excalidash.mdns.plist"
    launchctl bootout "$(macos_domain)/com.excalidash.mdns" >/dev/null 2>&1 || true
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.excalidash.mdns</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${SCRIPT_PATH}</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/excalidash-mdns.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/excalidash-mdns.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NAME</key><string>${NAME}</string>
    <key>MDNS_HOST</key><string>${MDNS_HOST}</string>
    <key>PORT</key><string>${PORT}</string>
  </dict>
</dict>
</plist>
EOF
    if launchctl bootstrap "$(macos_domain)" "$PLIST" 2>/dev/null; then
        echo "Loaded via 'launchctl bootstrap'."
    else
        launchctl load -w "$PLIST"
        echo "Loaded via 'launchctl load'."
    fi
    echo "Installed LaunchAgent: $PLIST"
    echo "Logs: $LOG_DIR/excalidash-mdns.log (.err.log)"
    echo "Starts at login, stays alive across reboots (RunAtLoad + KeepAlive),"
    echo "and re-detects your IP if you switch Wi-Fi / toggle a hotspot."
}

uninstall_macos() {
    launchctl bootout "$(macos_domain)/com.excalidash.mdns" >/dev/null 2>&1 || true
    PLIST="$HOME/Library/LaunchAgents/com.excalidash.mdns.plist"
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "Removed LaunchAgent: $PLIST"
}

status_macos() {
    if launchctl print "$(macos_domain)/com.excalidash.mdns" >/dev/null 2>&1; then
        echo "mDNS advertiser: RUNNING (launchd: com.excalidash.mdns)"
        launchctl print "$(macos_domain)/com.excalidash.mdns" 2>/dev/null \
            | grep -E 'state|last exit code|pid' | head -5
        return 0
    fi
    if launchctl list 2>/dev/null | grep -q 'com.excalidash.mdns'; then
        echo "mDNS advertiser: RUNNING (launchd legacy)"
        return 0
    fi
    echo "mDNS advertiser: NOT INSTALLED (run: $0 install)"
    return 1
}

restart_macos() {
    if launchctl print "$(macos_domain)/com.excalidash.mdns" >/dev/null 2>&1; then
        launchctl kickstart -k "$(macos_domain)/com.excalidash.mdns"
        echo "Restarted (launchctl kickstart)."
    else
        install_macos
    fi
}

# --- Persistent service: Linux (systemd user unit) ---------------------------
install_linux() {
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "NOTE: systemd not found on this Linux host." >&2
        echo "On Linux the recommended path is the avahi Docker sidecar:" >&2
        echo "  ./scripts/start-local.sh   (enables --profile mdns)" >&2
        echo "Or run this script in --daemon mode from your own init/cron:" >&2
        echo "  $0 --daemon" >&2
        exit 1
    fi
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    UNIT="$UNIT_DIR/excalidash-mdns.service"
    cat > "$UNIT" <<EOF
[Unit]
Description=ExcaliDash mDNS advertiser (${MDNS_HOST})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh ${SCRIPT_PATH} --daemon
Restart=always
RestartSec=10
Environment=NAME=${NAME}
Environment=MDNS_HOST=${MDNS_HOST}
Environment=PORT=${PORT}

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now excalidash-mdns
    echo "Installed systemd user service: $UNIT"
    echo "  systemctl --user status excalidash-mdns"
    echo "Optional (start before login / at boot): sudo loginctl enable-linger $USER"
    echo "NOTE: on Linux the avahi Docker sidecar (./scripts/start-local.sh) is the"
    echo "preferred path; this host unit is a fallback for native (non-Docker) dev."
}

uninstall_linux() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now excalidash-mdns >/dev/null 2>&1 || true
        rm -f "$HOME/.config/systemd/user/excalidash-mdns.service"
        systemctl --user daemon-reload 2>/dev/null || true
        echo "Removed systemd user service."
    else
        echo "systemd not found; nothing to remove."
    fi
}

status_linux() {
    if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active excalidash-mdns >/dev/null 2>&1; then
        echo "mDNS advertiser: RUNNING (systemd: excalidash-mdns)"
        systemctl --user status excalidash-mdns --no-pager 2>/dev/null | head -6
        return 0
    fi
    echo "mDNS advertiser: NOT RUNNING (run: $0 install, or use the avahi sidecar)"
    return 1
}

restart_linux() {
    if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active excalidash-mdns >/dev/null 2>&1; then
        systemctl --user restart excalidash-mdns
        echo "Restarted (systemctl --user restart)."
    else
        install_linux
    fi
}

# --- Persistent service: Windows (Startup-folder hidden launcher) -----------
windows_startup_dir() {
    # %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
    echo "${APPDATA}/Microsoft/Windows/Start Menu/Programs/Startup"
}

install_windows() {
    if ! command -v dns-sd.exe >/dev/null 2>&1; then
        echo "ERROR: dns-sd.exe not found." >&2
        echo "Install Bonjour (ships with iTunes, or 'Bonjour Print Services for Windows'):" >&2
        echo "  https://support.apple.com/bonjour" >&2
        exit 1
    fi
    SH_BIN="$(command -v sh || command -v bash || true)"
    if [ -z "$SH_BIN" ]; then
        echo "ERROR: need 'sh' (Git Bash / MSYS) to run the daemon." >&2
        exit 1
    fi
    STARTUP_DIR="$(windows_startup_dir)"
    mkdir -p "$STARTUP_DIR"
    CMD="$STARTUP_DIR/excalidash-mdns.cmd"
    VBS="$STARTUP_DIR/excalidash-mdns.vbs"
    # The .cmd loops so the daemon is relaunched if it ever exits; the daemon
    # itself re-detects the IP on Wi-Fi changes.
    cat > "$CMD" <<EOF
@echo off
:loop
"${SH_BIN}" "${SCRIPT_PATH}" --daemon
timeout /t 5 /nobreak >nul
goto loop
EOF
    # Hidden launcher so no console window pops at logon.
    cat > "$VBS" <<EOF
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c """ & "${CMD}" & """", 0, False
EOF
    # Start now without waiting for next logon.
    if command -v cscript.exe >/dev/null 2>&1; then
        cscript.exe //nologo "$VBS" >/dev/null 2>&1 || true
    fi
    echo "Installed Startup launcher: $CMD"
    echo "  hidden start: $VBS"
    echo "Starts at logon and survives reboots. Re-detects IP on Wi-Fi changes."
    echo "To stop: $0 uninstall"
}

uninstall_windows() {
    STARTUP_DIR="$(windows_startup_dir)"
    rm -f "$STARTUP_DIR/excalidash-mdns.cmd" "$STARTUP_DIR/excalidash-mdns.vbs"
    # Best-effort kill of a running daemon.
    taskkill.exe //F //IM dns-sd.exe >/dev/null 2>&1 || true
    echo "Removed Startup launcher."
}

status_windows() {
    CMD="$(windows_startup_dir)/excalidash-mdns.cmd"
    if [ -f "$CMD" ]; then
        echo "mDNS advertiser: INSTALLED (Startup: $(basename "$CMD"))"
        echo "Running dns-sd.exe: $(tasklist.exe //FI 'IMAGENAME eq dns-sd.exe' 2>/dev/null | grep -c dns-sd.exe 2>/dev/null || echo 0) process(es)"
        return 0
    fi
    echo "mDNS advertiser: NOT INSTALLED (run: $0 install)"
    return 1
}

restart_windows() {
    uninstall_windows
    install_windows
}

# --- Dispatch ----------------------------------------------------------------
case "${1:-}" in
    install)
        case "$OS" in
            Darwin) install_macos ;;
            Linux) install_linux ;;
            MINGW*|MSYS*|CYGWIN*) install_windows ;;
            *) echo "ERROR: unsupported OS '$OS'" >&2; exit 1 ;;
        esac
        ;;
    uninstall)
        case "$OS" in
            Darwin) uninstall_macos ;;
            Linux) uninstall_linux ;;
            MINGW*|MSYS*|CYGWIN*) uninstall_windows ;;
            *) echo "ERROR: unsupported OS '$OS'" >&2; exit 1 ;;
        esac
        ;;
    status)
        case "$OS" in
            Darwin) status_macos ;;
            Linux) status_linux ;;
            MINGW*|MSYS*|CYGWIN*) status_windows ;;
            *) echo "ERROR: unsupported OS '$OS'" >&2; exit 1 ;;
        esac
        ;;
    restart)
        case "$OS" in
            Darwin) restart_macos ;;
            Linux) restart_linux ;;
            MINGW*|MSYS*|CYGWIN*) restart_windows ;;
            *) echo "ERROR: unsupported OS '$OS'" >&2; exit 1 ;;
        esac
        ;;
    --daemon|-d)
        run_daemon
        ;;
    -h|--help)
        sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    "")
        run_foreground
        ;;
    *)
        echo "Unknown argument: $1" >&2
        echo "Try: $0 --help" >&2
        exit 1
        ;;
esac
