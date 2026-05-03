#!/usr/bin/env bash
set -euo pipefail

# ─── Colours ──────────────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $*"; }
info() { echo -e "${CYAN}[→]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# ─── Pre-flight ───────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  die "Run as root: sudo bash update.sh"
fi

FORCE=false
for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE=true
done

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BOLD}  VirtPilot — Update${NC}\n"
info "Project root: ${INSTALL_DIR}"

# ─── Pull latest ──────────────────────────────────────────────────────────────
info "Pulling latest changes..."
cd "$INSTALL_DIR"

# `npm install` below rewrites package-lock.json on the install host (e.g. adds
# linux-x64 binary entries that aren't in the macOS-generated lockfile). Discard
# that drift so the next `git pull --ff-only` doesn't abort on a dirty tree.
git checkout -- package-lock.json 2>/dev/null || true

BEFORE=$(git rev-parse HEAD)
git pull --ff-only
AFTER=$(git rev-parse HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
  if [[ "$FORCE" == true ]]; then
    warn "Already up to date — rebuilding anyway (--force)"
  else
    log "Already up to date ($(git rev-parse --short HEAD))"
    exit 0
  fi
fi

log "Updated $(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER")"
git log --oneline "${BEFORE}..${AFTER}"
echo ""

# ─── APT packages ─────────────────────────────────────────────────────────────
info "Ensuring system packages are present..."
apt-get install -y -qq \
  ovmf \
  swtpm \
  swtpm-tools \
  qemu-utils
log "System packages verified"

# ─── Storage directories (idempotent) ────────────────────────────────────────
STORAGE_ROOT="${STORAGE_ROOT:-/var/lib/virtpilot}"
mkdir -p "${STORAGE_ROOT}/backups"

# ─── TLS self-signed certificate (idempotent — generates only if missing) ────
TLS_DIR="${STORAGE_ROOT}/tls"
mkdir -p "${TLS_DIR}"
chmod 700 "${TLS_DIR}"

if [[ ! -f "${TLS_DIR}/cert.pem" || ! -f "${TLS_DIR}/key.pem" ]]; then
  HOST_NAME="$(hostname)"
  PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  PRIMARY_IP="${PRIMARY_IP:-127.0.0.1}"
  info "Generating self-signed TLS certificate (10 year validity, CN=${HOST_NAME})..."
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${TLS_DIR}/key.pem" \
    -out "${TLS_DIR}/cert.pem" \
    -days 3650 \
    -subj "/CN=${HOST_NAME}" \
    -addext "subjectAltName=DNS:${HOST_NAME},DNS:localhost,IP:${PRIMARY_IP},IP:127.0.0.1" \
    >/dev/null 2>&1
  chmod 600 "${TLS_DIR}/key.pem"
  chmod 644 "${TLS_DIR}/cert.pem"
  log "TLS certificate generated at ${TLS_DIR}/"
fi

# ─── Dependencies ─────────────────────────────────────────────────────────────
info "Installing npm dependencies..."
npm install --no-fund --no-audit

# ─── Build ────────────────────────────────────────────────────────────────────
info "Building VirtPilot..."
npm run build 2>&1
log "Build complete"

# ─── Restart service ──────────────────────────────────────────────────────────
info "Restarting service..."
systemctl restart virtpilot

sleep 2
if systemctl is-active --quiet virtpilot; then
  log "VirtPilot restarted successfully"
else
  warn "Service may not have started cleanly. Check: journalctl -u virtpilot -n 30"
  exit 1
fi

echo ""
echo -e "${BOLD}${GREEN}  Update complete.${NC}"
echo ""
