# 🎥 Live Streaming SaaS Platform

Self-hosted, multi-tenant **WebRTC live-streaming platform**.
Broadcasters register, book time slots, and go live from their **browser or OBS**.
Viewers log in with accounts the broadcaster creates. The admin approves
subscribers, sets capacity limits, and controls everything from a web panel.

| Component | Technology | Purpose |
|---|---|---|
| Reverse Proxy | Caddy 2 | Automatic HTTPS (Let's Encrypt), routing |
| Media Server | MediaMTX | WebRTC publish (WHIP) & playback (WHEP) |
| Backend | Node.js + Express | Auth, tickets, scheduling, admin API |
| Database | SQLite | Users, sessions, bookings, settings |
| Runtime | Docker Compose | One-command deploy & upgrade |

---

## 📑 Table of Contents

1. [Requirements](#-requirements--before-you-start)
2. [DNS Setup](#-dns-setup-do-this-first)
3. [Firewall Ports](#-firewall-ports)
4. [Repository Structure](#-repository-structure)
5. [Installation](#-installation)
6. [Input Parameters](#-input-parameters)
7. [Usage Guide](#-usage-guide)
8. [Updating / Upgrading](#-updating--upgrading)
9. [Handy Commands](#-handy-commands)
10. [Limitations](#-limitations--read-before-deploying)
11. [Security Notes](#-security-notes)
12. [Troubleshooting](#-troubleshooting)
13. [Script & Template Files](#-script--template-files)

---

## ✅ Requirements — Before You Start

| Item | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 / Debian 12 (**64-bit Linux only**) | Ubuntu 24.04 LTS |
| CPU | 1 vCPU | 2+ vCPU |
| RAM | 1 GB | 2–4 GB |
| Disk | 10 GB | 25 GB SSD |
| Network | Public **IPv4** (not behind NAT/CGNAT) | 1 Gbps unmetered |
| Access | Root / sudo | — |
| Software | None (installer sets up Docker) | — |

> ⚠️ **Windows and macOS servers are NOT supported** — the stack uses Docker
> `network_mode: host`, which only works on Linux.

---

## 🌐 DNS Setup (do this FIRST)

Create **two A records** at your DNS provider, both pointing to your server's public IP:

| Record Type | Hostname (example) | Points To | Purpose |
|---|---|---|---|
| A | `stream.yourdomain.com` | Your server IP | Portal, login, video |
| A | `api.yourdomain.com` | Your server IP | Backend API |

> ⚠️ TLS certificates are issued **automatically** by Caddy/Let's Encrypt.
> Certificate issuance **will fail** if DNS isn't pointing to the server yet.
> Wait for DNS to propagate before installing (check with `ping stream.yourdomain.com`).

---

## 🔥 Firewall Ports

The installer configures `ufw` automatically. If your host also has a
**cloud firewall** (AWS Security Group, DigitalOcean, Hetzner, Oracle, GCP),
open the same ports there — cloud firewalls sit *in front of* the server.

| Port | Protocol | Direction | Purpose | Required? |
|---|---|---|---|---|
| 22 | TCP | Inbound | SSH (your access) | ✅ Yes |
| 80 | TCP | Inbound | Let's Encrypt validation + HTTPS redirect | ✅ Yes |
| 443 | TCP | Inbound | HTTPS — all web traffic | ✅ Yes |
| 8189 | **UDP** | Inbound | WebRTC media (video/audio — primary) | ✅ **Critical** |
| 8189 | TCP | Inbound | WebRTC media (fallback for strict networks) | ✅ Yes |

> ⚠️ **If 8189/UDP is blocked, streams connect but show a black screen.**
> This is the #1 cause of installation problems.

---

## 📁 Repository Structure

| Path | Description |
|---|---|
| `install.sh` | One-time automated installer |
| `upgrade.sh` | Safe in-place upgrade script |
| `.env.example` | Template for input parameters |
| `docker-compose.yml` | Service definitions (reads secrets from `.env`) |
| `templates/Caddyfile.tpl` | Reverse-proxy config template (domains) |
| `templates/mediamtx.yml.tpl` | Media server config template (public IP) |
| `backend/` | Node.js API server + Dockerfile |
| `www/` | Frontend pages (login, admin, dashboard, studio, watch) |

**Runtime layout on the server (created by installer):**

| Path | Contents | Survives upgrade? |
|---|---|---|
| `/opt/saas/.env` | Your input parameters & admin password | ✅ Yes |
| `/opt/saas/backend/data/database.db` | All users, bookings, settings | ✅ Yes |
| `/opt/saas/backups/` | Automatic DB backups (made on every upgrade) | ✅ Yes |
| Everything else in `/opt/saas/` | Application code & generated configs | ♻️ Replaced |

---

## 🚀 Installation

### Option A — Interactive (asks 4 questions)

```bash
git clone https://github.com/migandhi/saasLiveStream.git
cd saasLiveStream
chmod +x install.sh upgrade.sh
sudo ./install.sh
```

### Option B — Fully unattended (no prompts)

```bash
sudo STREAM_DOMAIN=stream.example.com \
     API_DOMAIN=api.example.com \
     ADMIN_USER=admin \
     ADMIN_PASS='YourStrongPass123!' \
     ./install.sh --yes
```

### What the installer does automatically

| Step | Action |
|---|---|
| 1 | Checks OS, root access, prerequisites |
| 2 | Collects/validates input parameters (auto-detects public IP) |
| 3 | Warns if DNS records don't match the server IP |
| 4 | Installs Docker (if missing) |
| 5 | Opens firewall ports via `ufw` |
| 6 | Deploys files to `/opt/saas` |
| 7 | Writes `.env` and generates configs from templates |
| 8 | Builds and starts all containers |
| 9 | Health-checks the backend and prints your URLs |

### Verify installation

```bash
cd /opt/saas
docker compose ps          # all 3 services should show "Up"
docker compose logs -f     # watch logs (Ctrl+C to exit)
```

Open `https://stream.yourdomain.com` — first load may take **30–60 seconds**
while the TLS certificate is issued.

---

## ⚙️ Input Parameters

| Parameter | Example | Required | Notes |
|---|---|---|---|
| `STREAM_DOMAIN` | `stream.example.com` | ✅ | Where everyone logs in & watches |
| `API_DOMAIN` | `api.example.com` | ✅ | Backend API domain |
| `PUBLIC_IP` | `165.232.179.210` | Auto | Auto-detected — override only if wrong |
| `ADMIN_USER` | `admin` | Default: `admin` | Admin login name |
| `ADMIN_PASS` | *(hidden)* | ✅ | **Min 8 chars — choose a strong one** |

All parameters are saved to `/opt/saas/.env`. To change them later:
edit `/opt/saas/.env`, then run `sudo ./upgrade.sh`.

---

## 📖 Usage Guide

### 👑 Admin (platform owner)

| Task | How |
|---|---|
| Sign in | `https://stream.yourdomain.com` → admin credentials → lands on Admin panel |
| Approve broadcaster | New signups appear as **pending** → click *Approve* → set days (e.g. 30) |
| Renew / extend | Click *Renew* → enter days (adds to current expiry) |
| Suspend / reactivate | Click *Suspend* (kicks stream, frees slots) / *Reactivate* |
| Kick a live stream | *Kick stream* button appears next to any live broadcaster |
| Delete subscriber | *Delete* — removes them **and all their viewer accounts** |

**Capacity controls** (Admin panel → top card — tune to your bandwidth):

| Setting | What it controls | Default |
|---|---|---|
| Max simultaneous streams | Hard cap on concurrent broadcasts | 1 |
| Extra stream viewer threshold | 2nd stream allowed only if total viewers below this | 20 |
| Max viewers per room | Per-broadcast viewer cap | 50 |
| Max total viewers | Global bandwidth budget | 60 |
| Require booked slot (1/0) | Broadcasters may only go live inside a booking | 1 |
| Max upcoming bookings | Fairness quota per broadcaster | 3 |
| Max slot length (min) | Longest bookable slot | 120 |

### 📡 Broadcaster (your customer)

| Task | How |
|---|---|
| Register | Site → *Register as a broadcaster* → username, password, WhatsApp → wait for admin approval |
| Book a slot | Dashboard → *Book a Broadcast Slot* → title, date/time, minutes. Grey calendar rows = taken |
| Add viewers | Dashboard → *Viewer Accounts* → add one-by-one or bulk **CSV import** (`username,password` per line) |
| Export viewers | *Export CSV* button |
| Go live (browser) | *Open Studio* → **Go Live** → allow camera/mic (720p max, ~2.5 Mbps) |
| Go live (OBS) | Studio → *OBS link* → copy into OBS → Settings → Stream → Service: **WHIP** (token valid 5 min, single use) |
| Slot rules | Can start 10 min early; auto-kicked ~5 min after slot ends (if slots required) |

### 👀 Viewer

| Task | How |
|---|---|
| Watch | Sign in at `https://stream.yourdomain.com` with credentials from the broadcaster — that's it |
| Not live yet? | **Waiting Room** shows next scheduled broadcast; playback starts automatically |
| Sessions | One login per account — signing in on a 2nd device logs out the 1st (anti-sharing) |

---

## 🔄 Updating / Upgrading

```bash
cd YOURREPO        # your cloned repo folder
sudo ./upgrade.sh  # pulls latest code, rebuilds, restarts
```

| What upgrade.sh does | Preserved? |
|---|---|
| Backs up SQLite database to `/opt/saas/backups/` | — |
| Pulls latest code (`git pull`) | — |
| Syncs new code to `/opt/saas` | — |
| Your `.env` (domains, admin password) | ✅ Kept |
| Database (users, bookings, settings) | ✅ Kept |
| TLS certificates | ✅ Kept |
| Regenerates configs, rebuilds, restarts | ~30 s downtime |

> **Design note:** app code updates never require installer changes.
> Only add installer logic if a *new required input parameter* is introduced.

---

## 🛠 Handy Commands

| Command | Purpose |
|---|---|
| `cd /opt/saas && docker compose ps` | Service status |
| `docker compose logs -f backend` | Backend logs (live) |
| `docker compose logs -f caddy` | Proxy / TLS logs |
| `docker compose restart` | Restart everything |
| `docker compose down` | Stop (all data kept) |
| `docker compose up -d` | Start again |
| `cp backend/data/database.db ~/backup.db` | Manual database backup |

---

## ⚠️ Limitations — Read Before Deploying

### Platform / OS

| Limitation | Detail |
|---|---|
| Linux only | `network_mode: host` doesn't work on Windows/macOS Docker Desktop |
| Public IPv4 required | NAT/CGNAT hosts (home ISPs, some budget hosts) cannot deliver video — no built-in TURN relay |
| ARM64 supported | Raspberry Pi 4/5, Oracle Ampere, AWS Graviton work (backend build takes longer on ARM) |

### Bandwidth & Capacity (the real bottleneck)

WebRTC only, **no transcoding** — every viewer receives the full broadcast
bitrate (~2.5 Mbps at 720p):

| Server uplink | Realistic max concurrent viewers |
|---|---|
| 100 Mbps | ~30–35 |
| 500 Mbps | ~150 |
| 1 Gbps | ~300 |

Use the admin **Max total viewers** setting to stay inside your budget.

| Limitation | Detail |
|---|---|
| No quality adaptation | Slow viewers stutter rather than drop resolution (no HLS/ABR fallback) |
| HLS / RTMP / SRT / RTSP disabled | WebRTC (WHIP/WHEP) only, by design — sub-second latency |

### Client Side

| Limitation | Detail |
|---|---|
| Modern browser required | Chrome, Edge, Firefox, Safari 15+. Old browsers & most smart-TV browsers won't work |
| HTTPS required for camera | Always use the domain, never the raw IP |
| Strict firewalls | Corporate/school networks blocking UDP fall back to TCP 8189; rarely may fail entirely (no TURN) |
| iOS Safari | May require a tap to unmute audio (autoplay policy) |

### Architecture

| Limitation | Detail |
|---|---|
| Single server | SQLite, no clustering / horizontal scaling — for small/medium audiences |
| No recording / VOD | Streams are live-only, never stored |
| One session per account | By design (anti credential-sharing) |
| Backups | = copying one file: `backend/data/database.db` — do it regularly |

---

## 🔐 Security Notes

| Item | Detail |
|---|---|
| Never commit `.env` | Contains your admin password — already in `.gitignore` |
| Internal ports protected | Backend :3000, MediaMTX API :9997, WebRTC HTTP :8889 are localhost-only or fronted by Caddy |
| Exposed ports | Only 80, 443, 8189 |
| Stream access | Single-use 20-second tickets verified twice (API + MediaMTX auth webhook) — stream URLs can't be shared or leaked |
| Passwords | Salted `scrypt` hashes, timing-safe comparison |

---

## 🆘 Troubleshooting

| Symptom | Cause & Fix |
|---|---|
| TLS error / "connection not private" | DNS not pointing to server yet, or 80/443 blocked → wait for DNS, check firewall |
| Black screen / stuck "Connecting" | **8189/UDP blocked** (check cloud firewall!) or wrong `PUBLIC_IP` in `.env` → fix and run `sudo ./upgrade.sh` |
| "Awaiting approval" at login | Admin must approve the subscriber in the admin panel |
| Camera not working | Must use HTTPS domain; check browser camera permission |
| "You have no booked slot" | Book a slot first, or admin sets *Require booked slot* to `0` |
| Viewer says "at capacity" | Raise *Max viewers per room* / *Max total viewers* in admin panel |
| Forgot admin password | Edit `ADMIN_PASS` in `/opt/saas/.env` → `docker compose down && rm backend/data/database.db && docker compose up -d` ⚠️ **wipes all data** |

---

## 📜 Script & Template Files

<details>
<summary><b>📄 install.sh</b> (click to expand)</summary>

```bash
#!/usr/bin/env bash
# ============================================================
#  Live Streaming SaaS — Automated Installer
#  Interactive:  sudo ./install.sh
#  Unattended:   sudo STREAM_DOMAIN=stream.x.com API_DOMAIN=api.x.com \
#                     ADMIN_PASS='S3cret!' ./install.sh --yes
# ============================================================
set -euo pipefail

INSTALL_DIR="/opt/saas"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
UNATTENDED=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && UNATTENDED=true

log()  { echo -e "\e[32m[INSTALL]\e[0m $*"; }
err()  { echo -e "\e[31m[ERROR]\e[0m $*" >&2; exit 1; }

# ---------- 0. Pre-flight checks ----------
[[ $EUID -eq 0 ]] || err "Run as root: sudo ./install.sh"
[[ "$(uname -s)" == "Linux" ]] || err "Linux is required (network_mode: host is Linux-only)."
grep -qiE "ubuntu|debian" /etc/os-release || log "WARNING: tested on Ubuntu 22.04/24.04 & Debian 12. Continuing…"
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl >/dev/null; }
command -v envsubst >/dev/null || apt-get install -y -qq gettext-base >/dev/null
command -v rsync >/dev/null || apt-get install -y -qq rsync >/dev/null

# ---------- 1. Collect input parameters ----------
[[ -f "$INSTALL_DIR/.env" ]] && set -a && source "$INSTALL_DIR/.env" && set +a

ask() { # ask VAR "Prompt" [default]
  local var="$1" prompt="$2" def="${3:-}"
  if [[ -z "${!var:-}" ]]; then
    $UNATTENDED && { [[ -n "$def" ]] && eval "$var=\"$def\"" || err "Missing required parameter: $var"; return; }
    read -rp "$prompt${def:+ [$def]}: " val
    eval "$var=\"${val:-$def}\""
  fi
}

ask STREAM_DOMAIN "Streaming domain (e.g. stream.example.com)"
ask API_DOMAIN    "API domain (e.g. api.example.com)"
ask PUBLIC_IP     "Public IPv4 of this server" "$(curl -4 -s --max-time 5 ifconfig.me || true)"
ask ADMIN_USER    "Admin username" "admin"
if [[ -z "${ADMIN_PASS:-}" ]]; then
  $UNATTENDED && err "ADMIN_PASS is required in unattended mode"
  read -rsp "Admin password (min 8 chars): " ADMIN_PASS; echo
fi
[[ ${#ADMIN_PASS} -ge 8 ]] || err "Admin password must be at least 8 characters."
[[ -n "$PUBLIC_IP" ]] || err "Could not detect public IP — set PUBLIC_IP manually."

# ---------- 2. Verify DNS (warn only) ----------
for d in "$STREAM_DOMAIN" "$API_DOMAIN"; do
  resolved=$(getent hosts "$d" | awk '{print $1}' | head -1 || true)
  [[ "$resolved" == "$PUBLIC_IP" ]] || log "WARNING: DNS for $d resolves to '${resolved:-nothing}', expected $PUBLIC_IP. TLS WILL FAIL until DNS is correct."
done

# ---------- 3. Install Docker (if missing) ----------
if ! command -v docker >/dev/null; then
  log "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || err "Docker Compose plugin missing. Install docker-compose-plugin."

# ---------- 4. Configure firewall (ufw, if present) ----------
if command -v ufw >/dev/null; then
  log "Configuring firewall (ufw)…"
  ufw allow 22/tcp   >/dev/null   # SSH — never lock yourself out
  ufw allow 80/tcp   >/dev/null   # HTTP (Let's Encrypt + redirect)
  ufw allow 443/tcp  >/dev/null   # HTTPS (Caddy)
  ufw allow 8189/udp >/dev/null   # WebRTC media (UDP preferred)
  ufw allow 8189/tcp >/dev/null   # WebRTC media (TCP fallback)
  ufw --force enable >/dev/null
else
  log "ufw not found — open 80/tcp, 443/tcp, 8189/udp, 8189/tcp in your cloud firewall."
fi

# ---------- 5. Deploy files ----------
log "Deploying to $INSTALL_DIR…"
mkdir -p "$INSTALL_DIR"
rsync -a --exclude '.git' --exclude 'backend/data' "$REPO_DIR/" "$INSTALL_DIR/"
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
envsubst '${API_DOMAIN} ${STREAM_DOMAIN}' < "$INSTALL_DIR/templates/Caddyfile.tpl"    > "$INSTALL_DIR/Caddyfile"
envsubst '${PUBLIC_IP}'                    < "$INSTALL_DIR/templates/mediamtx.yml.tpl" > "$INSTALL_DIR/mediamtx.yml"

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
log " ✅ Installation complete!"
log ""
log "   Portal (login/watch):   https://$STREAM_DOMAIN"
log "   Admin panel:            https://$STREAM_DOMAIN/admin.html"
log "   Admin user:             $ADMIN_USER"
log ""
log "   ⏳ TLS certificates are issued automatically on first"
log "      visit — allow 30–60 seconds after DNS is live."
log ""
log "   Logs:     cd $INSTALL_DIR && docker compose logs -f"
log "   Upgrade:  sudo ./upgrade.sh"
log "============================================================"
```

</details>

<details>
<summary><b>📄 upgrade.sh</b> (click to expand)</summary>

```bash
#!/usr/bin/env bash
# ============================================================
#  Upgrade in place. Keeps .env, database, TLS certificates.
#  Usage: sudo ./upgrade.sh
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
[[ -d "$REPO_DIR/.git" ]] && git -C "$REPO_DIR" pull --ff-only

echo "[UPGRADE] Syncing files (database & .env preserved)…"
rsync -a --exclude '.git' --exclude 'backend/data' --exclude '.env' \
      --exclude 'backups' "$REPO_DIR/" "$INSTALL_DIR/"

echo "[UPGRADE] Regenerating configs…"
set -a; source "$INSTALL_DIR/.env"; set +a
envsubst '${API_DOMAIN} ${STREAM_DOMAIN}' < "$INSTALL_DIR/templates/Caddyfile.tpl"    > "$INSTALL_DIR/Caddyfile"
envsubst '${PUBLIC_IP}'                    < "$INSTALL_DIR/templates/mediamtx.yml.tpl" > "$INSTALL_DIR/mediamtx.yml"

echo "[UPGRADE] Rebuilding and restarting…"
cd "$INSTALL_DIR"
docker compose up -d --build

echo "[UPGRADE] ✅ Done. Check: docker compose ps"
```

</details>

<details>
<summary><b>📄 .env.example</b> (click to expand)</summary>

```bash
# ======= REQUIRED INPUT PARAMETERS =======
STREAM_DOMAIN=stream.example.com     # viewers & broadcasters use this
API_DOMAIN=api.example.com           # backend API domain
PUBLIC_IP=                           # server's public IPv4 (auto-detected if empty)
ADMIN_USER=admin
ADMIN_PASS=                          # REQUIRED — set a strong password (min 8 chars)
```

</details>

<details>
<summary><b>📄 templates/Caddyfile.tpl</b> (click to expand)</summary>

```
${API_DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}

${STREAM_DOMAIN} {
    encode gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }

    handle /live/* {
        reverse_proxy 127.0.0.1:8889
    }

    handle {
        root * /srv/www
        file_server
    }
}
```

</details>

<details>
<summary><b>📄 templates/mediamtx.yml.tpl</b> (click to expand)</summary>

```yaml
logLevel: info
api: yes
apiAddress: 127.0.0.1:9997

authMethod: http
authHTTPAddress: http://127.0.0.1:3000/api/mtx/auth
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

hls: no
rtmp: no
srt: no
rtsp: no

webrtc: yes
webrtcAddress: :8889
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
webrtcIPsFromInterfaces: no
webrtcAdditionalHosts: ["${PUBLIC_IP}"]

paths:
  "~^live/([a-zA-Z0-9_-]{4,64})$":
    source: publisher
```

</details>

<details>
<summary><b>📄 docker-compose.yml</b> (click to expand)</summary>

```yaml
version: "3.8"
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./www:/srv/www:ro
      - caddy_data:/data
    logging: { driver: "json-file", options: { max-size: "10m", max-file: "3" } }
    depends_on: [backend, mediamtx]

  mediamtx:
    image: bluenviron/mediamtx:1.9.3
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./mediamtx.yml:/mediamtx.yml:ro
    logging: { driver: "json-file", options: { max-size: "10m", max-file: "3" } }

  backend:
    build: ./backend
    restart: unless-stopped
    network_mode: host
    environment:
      - NODE_ENV=production
      - ADMIN_USER=${ADMIN_USER:-admin}
      - ADMIN_PASS=${ADMIN_PASS:?Set ADMIN_PASS in .env}
    volumes:
      - ./backend/data:/app/data
    logging: { driver: "json-file", options: { max-size: "10m", max-file: "3" } }

volumes:
  caddy_data:
```

</details>

<details>
<summary><b>📄 .gitignore</b> (click to expand)</summary>

```
.env
backend/data/
backups/
node_modules/
```

</details>

---

## ⚡ TL;DR — Three Commands

```bash
git clone https://github.com/migandhi/saasLiveStream.git && cd saasLiveStream
chmod +x install.sh upgrade.sh
sudo ./install.sh
```
