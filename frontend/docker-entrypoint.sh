#!/bin/sh
# Alpine-based image uses /bin/sh (busybox ash), not bash
set -e

# Set default backend URL if not provided (host:port format, no protocol)
export BACKEND_URL="${BACKEND_URL:-backend:8000}"

# SSL certificate paths (mounted as a volume by docker-compose.prod.ssl.yml).
# When both files exist, nginx serves HTTPS on :443 and redirects :80 -> :443.
SSL_CERT_PATH="${SSL_CERT_PATH:-/certs/fullchain.pem}"
SSL_KEY_PATH="${SSL_KEY_PATH:-/certs/privkey.pem}"

# Escape a value for safe sed substitution of placeholders.
escape_for_sed() {
    printf '%s\n' "$1" | sed 's/[\/&]/\\&/g'
}

ESCAPED_BACKEND_URL=$(escape_for_sed "$BACKEND_URL")

if [ -f "$SSL_CERT_PATH" ] && [ -f "$SSL_KEY_PATH" ]; then
    echo "Configuring nginx for HTTPS (cert=${SSL_CERT_PATH}, key=${SSL_KEY_PATH})"
    ESCAPED_SSL_CERT=$(escape_for_sed "$SSL_CERT_PATH")
    ESCAPED_SSL_KEY=$(escape_for_sed "$SSL_KEY_PATH")
    sed \
        -e "s/__BACKEND_URL__/${ESCAPED_BACKEND_URL}/g" \
        -e "s/__SSL_CERT__/${ESCAPED_SSL_CERT}/g" \
        -e "s/__SSL_KEY__/${ESCAPED_SSL_KEY}/g" \
        /etc/nginx/nginx.ssl.conf.template > /etc/nginx/nginx.conf
else
    echo "Configuring nginx (HTTP only) with BACKEND_URL: ${BACKEND_URL}"
    if [ -n "${SSL_CERT_PATH}${SSL_KEY_PATH}" ]; then
        echo "WARNING: SSL_CERT_PATH/SSL_KEY_PATH set but cert files not found; falling back to HTTP"
    fi
    sed "s/__BACKEND_URL__/${ESCAPED_BACKEND_URL}/g" /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf
fi

# Validate the generated nginx configuration before starting
echo "Validating nginx configuration..."
if ! nginx -t -c /etc/nginx/nginx.conf; then
    echo "ERROR: nginx configuration validation failed" >&2
    exit 1
fi

# Execute the main command (nginx)
exec "$@"
