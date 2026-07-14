#!/usr/bin/env bash
# ============================================================
# Upgrade the Live Streaming SaaS in place.
# - Keeps .env, database, and TLS certificates
# - Regenerates configs from (possibly updated) templates
# Usage: sudo ./upgrade.sh
# ============================================================
set -euo pipefail
INSTALL_DIR="/opt/saas"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "Run as root"; exit 1; }
[[ -f "$INSTALL_DIR/.env" ]] || { echo "Not installed — run install.sh first"; exit 1; }
echo "[UPGRADE] Backing up database…"
mkdir -p "$INSTALL_DIR/backups"
cp "$INSTALL_DIR/backend/data/database.db" \
"$INSTALL_DIR/backups/database-$(date +%Y%m%d-%H%M%S).db" 2>/dev/null || true
echo "[UPGRADE] Pulling latest code…"
if [[ -d "$REPO_DIR/.git" ]]; then git -C "$REPO_DIR" pull --ff-only; fi
echo "[UPGRADE] Syncing files (database & .env preserved)…"
rsync -a --exclude '.git' --exclude 'backend/data' --exclude '.env' \
--exclude 'backups' "$REPO_DIR/" "$INSTALL_DIR/"
echo "[UPGRADE] Regenerating configs…"
set -a; source "$INSTALL_DIR/.env"; set +a
envsubst '${API_DOMAIN} ${STREAM_DOMAIN}' < "$INSTALL_DIR/templates/Caddyfile.tpl"
> "$INSTALL_DIR/Caddyfile"
envsubst '${PUBLIC_IP}' < "$INSTALL_DIR/templates/mediamtx.yml.tpl" >
"$INSTALL_DIR/mediamtx.yml"
echo "[UPGRADE] Rebuilding and restarting…"
cd "$INSTALL_DIR"
docker compose up -d --build
echo "[UPGRADE] Done. Check: docker compose ps"
