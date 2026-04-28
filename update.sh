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

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BOLD}  VirtPilot — Update${NC}\n"
info "Project root: ${INSTALL_DIR}"

# ─── Pull latest ──────────────────────────────────────────────────────────────
info "Pulling latest changes..."
cd "$INSTALL_DIR"

BEFORE=$(git rev-parse HEAD)
git pull --ff-only
AFTER=$(git rev-parse HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
  log "Already up to date ($(git rev-parse --short HEAD))"
  exit 0
fi

log "Updated $(git rev-parse --short "$BEFORE") → $(git rev-parse --short "$AFTER")"
git log --oneline "${BEFORE}..${AFTER}"
echo ""

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
