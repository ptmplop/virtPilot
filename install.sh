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

# ─── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
cat << 'BANNER'
  __   _      _   ___  _  _     _
  \ \ / /_ __| |_| _ \(_)| |___| |_
   \ V /| |  _|  _|  _/ | | / _ \  _|
    \_/ |_|\__|\__|_| |_|_|_\___/\__|

BANNER
echo -e "${NC}${BOLD}  VirtPilot — KVM Virtual Machine Manager${NC}"
echo -e "  Installer for Ubuntu 24\n"

# ─── Pre-flight checks ────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  die "Run this installer as root: sudo bash install.sh"
fi

if ! grep -qi 'ubuntu' /etc/os-release 2>/dev/null; then
  warn "This installer targets Ubuntu 24. Proceeding on unrecognised OS..."
fi

# Absolute path to the directory containing this script (the project root)
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info "Project root: ${INSTALL_DIR}"

# ─── APT dependencies ─────────────────────────────────────────────────────────
info "Updating package lists..."
apt-get update -qq

info "Installing system dependencies..."
apt-get install -y -qq \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  virtinst \
  genisoimage \
  bridge-utils \
  iptables \
  curl \
  openssl \
  ca-certificates \
  gnupg \
  build-essential \
  python3

# ─── Node.js 20 ───────────────────────────────────────────────────────────────
NODE_MAJOR=20
REQUIRED_NODE="v${NODE_MAJOR}"

if node --version 2>/dev/null | grep -q "^${REQUIRED_NODE}"; then
  log "Node.js $(node --version) already installed"
else
  info "Installing Node.js ${NODE_MAJOR} via NodeSource..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  log "Node.js $(node --version) installed"
fi

# ─── libvirtd ─────────────────────────────────────────────────────────────────
systemctl enable --quiet libvirtd
systemctl start libvirtd
log "libvirtd running"

# ─── Build ────────────────────────────────────────────────────────────────────
info "Installing npm dependencies (this may take a minute on first run)..."
cd "$INSTALL_DIR"
npm install --no-fund --no-audit

info "Building VirtPilot..."
npm run build 2>&1
log "Build complete"

# ─── Storage directories ──────────────────────────────────────────────────────
info "Creating storage directories at /var/lib/virtpilot..."
mkdir -p \
  /var/lib/virtpilot/templates \
  /var/lib/virtpilot/isos \
  /var/lib/virtpilot/vms \
  /var/lib/virtpilot/cloud-init
chmod -R 755 /var/lib/virtpilot
log "Storage ready"

# ─── Password setup ───────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Set a login password for the VirtPilot web UI:${NC}"
while true; do
  read -rsp "  Password : " VP_PASSWORD; echo
  if [[ ${#VP_PASSWORD} -lt 8 ]]; then
    warn "Password must be at least 8 characters. Try again."
    continue
  fi
  read -rsp "  Confirm  : " VP_PASSWORD2; echo
  if [[ "$VP_PASSWORD" == "$VP_PASSWORD2" ]]; then
    break
  fi
  warn "Passwords do not match. Try again."
done
echo ""

# ─── Generate JWT secret ──────────────────────────────────────────────────────
JWT_SECRET=$(openssl rand -hex 32)

# ─── Write .env ───────────────────────────────────────────────────────────────
info "Writing configuration..."
cat > "${INSTALL_DIR}/packages/backend/.env" << EOF
PORT=3001
NODE_ENV=production

STORAGE_ROOT=/var/lib/virtpilot
TEMPLATES_DIR=/var/lib/virtpilot/templates
ISOS_DIR=/var/lib/virtpilot/isos
VMS_DIR=/var/lib/virtpilot/vms
CLOUD_INIT_DIR=/var/lib/virtpilot/cloud-init

DEFAULT_BRIDGE=br0
LIBVIRT_URI=qemu:///system

AUTH_PASSWORD=${VP_PASSWORD}
JWT_SECRET=${JWT_SECRET}
EOF
chmod 600 "${INSTALL_DIR}/packages/backend/.env"
log "Configuration written"

# ─── Systemd service ──────────────────────────────────────────────────────────
NODE_BIN="$(command -v node)"

info "Installing systemd service..."
cat > /etc/systemd/system/virtpilot.service << EOF
[Unit]
Description=VirtPilot KVM Manager
After=network.target libvirtd.service
Wants=libvirtd.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/packages/backend/dist/index.js
EnvironmentFile=${INSTALL_DIR}/packages/backend/.env
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=virtpilot

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable virtpilot
systemctl restart virtpilot

# Brief wait then check status
sleep 2
if systemctl is-active --quiet virtpilot; then
  log "VirtPilot service started"
else
  warn "Service may not have started cleanly. Check: journalctl -u virtpilot -n 30"
fi

# ─── Connection info ──────────────────────────────────────────────────────────
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
HOST_IP="${HOST_IP:-<your-server-ip>}"

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  VirtPilot is installed and running!${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Web UI:${NC}      ${CYAN}http://${HOST_IP}:3001${NC}"
echo -e "  ${BOLD}Password:${NC}    the one you just set"
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    systemctl status virtpilot"
echo -e "    journalctl -u virtpilot -f"
echo -e "    systemctl restart virtpilot"
echo ""
