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

REPO_URL="https://github.com/ptmplop/virtPilot.git"
INSTALL_DIR="/usr/local/virtpilot"

# ─── Pre-flight ───────────────────────────────────────────────────────────────
echo -e "${BOLD}  VirtPilot — Bootstrap${NC}"
echo -e "  Clones VirtPilot to ${INSTALL_DIR} and runs the installer\n"

if [[ $EUID -ne 0 ]]; then
  die "Run as root: curl -fsSL <bootstrap-url> | sudo bash"
fi

# Architecture must be amd64/x86_64
ARCH="$(uname -m)"
if [[ "${ARCH}" != "x86_64" ]]; then
  die "Unsupported architecture: ${ARCH}. VirtPilot supports amd64 (x86_64) only."
fi

# OS must be Ubuntu 24.04 — fail fast before we install git or clone
if [[ ! -r /etc/os-release ]]; then
  die "/etc/os-release not found — cannot verify OS. VirtPilot supports Ubuntu 24.04 only."
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]] || [[ "${VERSION_ID:-}" != "24.04" ]]; then
  die "Unsupported OS: ${PRETTY_NAME:-unknown}. VirtPilot supports Ubuntu 24.04 only."
fi

# ─── Ensure git is present ────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  info "Installing git..."
  apt-get update -qq
  apt-get install -y -qq git
  log "git installed"
fi

# ─── Clone or update ──────────────────────────────────────────────────────────
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  info "Existing clone found at ${INSTALL_DIR} — pulling latest..."
  cd "${INSTALL_DIR}"
  git fetch --quiet origin
  git reset --hard --quiet origin/main
  log "Updated to $(git rev-parse --short HEAD)"
elif [[ -e "${INSTALL_DIR}" ]]; then
  die "${INSTALL_DIR} exists but is not a git clone — refusing to overwrite. Move or remove it and re-run."
else
  info "Cloning ${REPO_URL} → ${INSTALL_DIR}..."
  git clone --quiet "${REPO_URL}" "${INSTALL_DIR}"
  log "Cloned to ${INSTALL_DIR}"
fi

# ─── Hand off to installer ────────────────────────────────────────────────────
cd "${INSTALL_DIR}"
exec bash install.sh "$@"
