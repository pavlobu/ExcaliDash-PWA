# Minimal avahi daemon used to advertise ExcaliDash as excalidash.local on the
# local network via Bonjour/mDNS (_https._tcp). Run with network_mode: host on
# Linux so multicast reaches the host's Wi-Fi interface. On Docker Desktop
# (macOS/Windows) host networking does not propagate mDNS; use
# scripts/register-bonjour.sh on the host instead.

FROM alpine:latest

RUN apk add --no-cache avahi avahi-tools tini

COPY avahi-daemon.conf /etc/avahi/avahi-daemon.conf
COPY services/excalidash.service /etc/avahi/services/excalidash.service

# mDNS uses UDP 5353 multicast. Requires host networking to actually broadcast.
EXPOSE 5353/udp

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["avahi-daemon", "--no-chroot", "--no-drop-root", "-f", "/etc/avahi/avahi-daemon.conf"]
