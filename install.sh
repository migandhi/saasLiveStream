#!/usr/bin/env bash
# ============================================================
# Live Streaming SaaS — Automated Installer
# Usage (interactive): sudo ./install.sh
# Usage (unattended): sudo STREAM_DOMAIN=stream.x.com API_DOMAIN=api.x.com \
# ADMIN_PASS='S3cret!' ./install.sh --yes
# ============================================================
set -euo pipefail
INSTALL_DIR="/opt/saas"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
UNATTENDED=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && UNATTENDED=true
log() { echo -e "\e[32m[INSTALL]\e[0m $*"; }
err() { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }
# ---------- 0. Pre-flight checks ----------
[[ $EUID -eq 0 ]] || err "Run as root: sudo ./install.sh"
[[ "$(uname -s)" == "Linux" ]] || err "Linux is required (network_mode: host is Linux-only)."
grep -qiE "ubuntu|debian" /etc/os-release || log "WARNING: tested on Ubuntu 22.04/24.04
& Debian 12. Continuing anyway…"
command -v curl >/dev/null || apt-get update -qq && apt-get install -y -qq curl >/dev/null
# ---------- 1. Collect input parameters ----------
# Load .env if it already exists (re-runs / upgrades keep old answers)
[[ -f "$INSTALL_DIR/.env" ]] && set -a && source "$INSTALL_DIR/.env" && set +a
ask() { # ask VAR "Prompt" [default]
local var="$1" prompt="$2" def="${3:-}"
if [[ -z "${!var:-}" ]]; then
$UNATTENDED && { [[ -n "$def" ]] && eval "$var=\"$def\"" || err "Missing required
parameter: $var"; return; }
read -rp "$prompt${def:+ [$def]}: " val
eval "$var=\"${val:-$def}\""
fi
}
ask STREAM_DOMAIN "Streaming domain (e.g. stream.example.com)"
ask API_DOMAIN "API domain (e.g. api.example.com)"
ask PUBLIC_IP "Public IPv4 of this server" "$(curl -4 -s --max-time 5 ifconfig.me || true)"
ask ADMIN_USER "Admin username" "admin"
if [[ -z "${ADMIN_PASS:-}" ]]; then
$UNATTENDED && err "ADMIN_PASS is required in unattended mode"
read -rsp "Admin password (min 8 chars): " ADMIN_PASS; echo
fi
[[ ${#ADMIN_PASS} -ge 8 ]] || err "Admin password must be at least 8 characters."
[[ -n "$PUBLIC_IP" ]] || err "Could not detect public IP — set PUBLIC_IP manually."
# ---------- 2. Verify DNS (warn only) ----------
for d in "$STREAM_DOMAIN" "$API_DOMAIN"; do
resolved=$(getent hosts "$d" | awk '{print $1}' | head -1 || true)
[[ "$resolved" == "$PUBLIC_IP" ]] || log "WARNING: DNS for $d resolves to '${resolved:-
nothing}', expected $PUBLIC_IP. TLS certificates WILL FAIL until DNS is correct."
done
# ---------- 3. Install Docker (if missing) ----------
if ! command -v docker >/dev/null; then
log "Installing Docker…"
curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || err "Docker Compose plugin missing. Install
docker-compose-plugin."
# ---------- 4. Configure firewall (ufw, if present) ----------
if command -v ufw >/dev/null; then
log "Configuring firewall (ufw)…"
ufw allow 22/tcp >/dev/null # SSH — never lock yourself out
ufw allow 80/tcp >/dev/null # HTTP (Let's Encrypt + redirect)
ufw allow 443/tcp >/dev/null # HTTPS (Caddy)
ufw allow 8189/udp >/dev/null # WebRTC media (UDP preferred)
ufw allow 8189/tcp >/dev/null # WebRTC media (TCP fallback)
ufw --force enable >/dev/null
else
log "ufw not found — open ports 80/tcp, 443/tcp, 8189/udp, 8189/tcp in your cloud
firewall."
fi
# ---------- 5. Deploy files ----------
log "Deploying to $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
# Copy application files (preserves backend/data on re-runs)
rsync -a --exclude '.git' --exclude 'backend/data' "$REPO_DIR/" "$INSTALL_DIR/"
2>/dev/null \
|| cp -rn "$REPO_DIR/." "$INSTALL_DIR/"
mkdir -p "$INSTALL_DIR/backend/data"
# ---------- 6. Write .env & generate configs from templates ----------
cat > "$INSTALL_DIR/.env" <<EOF
STREAM_DOMAIN=$STREAM_DOMAIN
API_DOMAIN=$API_DOMAIN
PUBLIC_IP=$PUBLIC_IP
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
EOF
chmod 600 "$INSTALL_DIR/.env"
export STREAM_DOMAIN API_DOMAIN PUBLIC_IP
envsubst '${API_DOMAIN} ${STREAM_DOMAIN}' < "$INSTALL_DIR/templates/Caddyfile.tpl"
> "$INSTALL_DIR/Caddyfile"
envsubst '${PUBLIC_IP}' < "$INSTALL_DIR/templates/mediamtx.yml.tpl" >
"$INSTALL_DIR/mediamtx.yml"
# ---------- 7. Build & start ----------
log "Building and starting containers (first run may take a few minutes)…"
cd "$INSTALL_DIR"
docker compose up -d --build
# ---------- 8. Health check ----------
log "Waiting for backend…"
for i in {1..30}; do
curl -s -o /dev/null http://127.0.0.1:3000/api/me && break || sleep 2
done
log "============================================================"
log " Installation complete!"
log ""
log " Portal (login/watch): https://$STREAM_DOMAIN"
log " Admin panel: https://$STREAM_DOMAIN/admin.html"
log " Admin user: $ADMIN_USER"
log ""
log " TLS certificates are issued automatically on first"
log " visit — allow 30–60 seconds after DNS is live."
log ""
log " Logs: cd $INSTALL_DIR && docker compose logs -f"
log " Upgrade: sudo ./upgrade.sh"
log "============================================================"
