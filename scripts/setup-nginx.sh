#!/usr/bin/env bash
#
# setup-nginx.sh — Put DassTracker behind nginx on a public IP with a
# self-signed TLS cert and HTTP basic auth. Run as root on the Hetzner server
# AFTER the dasstracker systemd service is already running on 127.0.0.1:3000.
#
# Usage:  sudo bash scripts/setup-nginx.sh [auth_username]
# Example: sudo bash scripts/setup-nginx.sh darshan
#
# The app stays bound to 127.0.0.1; nginx is the only public-facing piece.
# Security posture: single basic-auth user over self-signed TLS. Fine for a
# personal scraper; the browser will warn once about the self-signed cert.

set -euo pipefail

AUTH_USER="${1:-darshan}"

echo ">> Installing nginx + htpasswd tooling..."
apt-get update -y
apt-get install -y nginx apache2-utils openssl

echo ">> Creating basic-auth user '${AUTH_USER}' (you'll be prompted for a password)..."
htpasswd -c /etc/nginx/.htpasswd "${AUTH_USER}"

echo ">> Generating self-signed TLS cert (valid 10 years)..."
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/ssl/private/dass-selfsigned.key \
  -out /etc/ssl/certs/dass-selfsigned.crt \
  -subj "/CN=dasstracker"

echo ">> Writing nginx site config..."
cat > /etc/nginx/sites-available/dasstracker <<'EOF'
server {
    listen 443 ssl;
    ssl_certificate     /etc/ssl/certs/dass-selfsigned.crt;
    ssl_certificate_key /etc/ssl/private/dass-selfsigned.key;

    location / {
        auth_basic "DassTracker";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}

# Redirect plain HTTP to HTTPS.
server {
    listen 80;
    return 301 https://$host$request_uri;
}
EOF

ln -sf /etc/nginx/sites-available/dasstracker /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

echo ">> Testing and reloading nginx..."
nginx -t
systemctl reload nginx

echo ">> Opening firewall for web traffic (SSH kept open)..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo
echo "Done. Visit https://YOUR_SERVER_IP , accept the self-signed cert warning,"
echo "and log in as '${AUTH_USER}'."
