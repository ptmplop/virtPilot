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

# Architecture must be amd64/x86_64
ARCH="$(uname -m)"
if [[ "${ARCH}" != "x86_64" ]]; then
  die "Unsupported architecture: ${ARCH}. VirtPilot supports amd64 (x86_64) only."
fi

# OS must be Ubuntu 24.04
if [[ ! -r /etc/os-release ]]; then
  die "/etc/os-release not found — cannot verify OS. VirtPilot supports Ubuntu 24.04 only."
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]] || [[ "${VERSION_ID:-}" != "24.04" ]]; then
  die "Unsupported OS: ${PRETTY_NAME:-unknown}. VirtPilot supports Ubuntu 24.04 only."
fi

# Absolute path to the directory containing this script (the project root)
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STANDARD_DIR="/usr/local/virtpilot"
SERVICE_USER="virtpilot"

# Public port the dashboard is reachable on. Backend port is the internal one
# Node binds to (used only when nginx is fronting; the no-nginx flow keeps the
# backend on PUBLIC_PORT directly). Declared up here so the .env template can
# reference them in comments before the nginx flow runs.
PUBLIC_PORT=3001
BACKEND_PORT=3002

info "Project root: ${INSTALL_DIR}"

# Self-upgrade requires a git clone (update.sh runs `git pull`)
if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  die "VirtPilot must be installed from a git clone (no .git directory at ${INSTALL_DIR}). Use bootstrap.sh or run: git clone https://github.com/ptmplop/virtPilot.git ${STANDARD_DIR} && cd ${STANDARD_DIR} && sudo bash install.sh"
fi

# We chown the install dir to the virtpilot user later; persist a safe.directory
# entry in root's gitconfig so subsequent root-run git operations (re-running
# install.sh, future bootstrap.sh runs) don't get blocked by "dubious ownership".
git config --global --add safe.directory "${INSTALL_DIR}" 2>/dev/null || true

if [[ "${INSTALL_DIR}" != "${STANDARD_DIR}" ]]; then
  warn "Installing outside the standard path ${STANDARD_DIR} — fine for development, but the bootstrap installer expects ${STANDARD_DIR}."
fi

# ─── APT dependencies ─────────────────────────────────────────────────────────
info "Updating package lists..."
apt-get update -qq

info "Installing system dependencies..."
apt-get install -y -qq \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  virtinst \
  ovmf \
  swtpm \
  swtpm-tools \
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

# ─── Service user ─────────────────────────────────────────────────────────────
# Run the backend as a dedicated unprivileged user. libvirt access is granted
# via `libvirt` group membership; the user has no shell and no home directory
# of its own beyond the install dir.
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  info "Creating ${SERVICE_USER} system user..."
  useradd --system --shell /usr/sbin/nologin --home-dir "${INSTALL_DIR}" --comment "VirtPilot service" "${SERVICE_USER}"
  log "Created ${SERVICE_USER}"
fi
usermod -aG libvirt "${SERVICE_USER}" || true
usermod -aG kvm "${SERVICE_USER}" || true

# ─── libvirtd ─────────────────────────────────────────────────────────────────
systemctl enable --quiet libvirtd
systemctl start libvirtd
log "libvirtd running"

# ─── Build ────────────────────────────────────────────────────────────────────
info "Installing npm dependencies (this may take a minute on first run)..."
cd "$INSTALL_DIR"
# Use `npm ci` to enforce the lockfile — refuses to install if the lockfile
# disagrees with package.json, defending against tampered npm registry mirrors.
# Falls back to `npm install` if the lockfile is missing (first-time clones
# from a tag that pre-dates lockfile commits).
if [[ -f package-lock.json ]]; then
  npm ci --no-fund --no-audit
else
  npm install --no-fund --no-audit
fi

info "Building VirtPilot..."
npm run build 2>&1
log "Build complete"

# ─── Storage directories ──────────────────────────────────────────────────────
info "Creating storage directories at /var/lib/virtpilot..."
mkdir -p \
  /var/lib/virtpilot/templates \
  /var/lib/virtpilot/isos \
  /var/lib/virtpilot/vms \
  /var/lib/virtpilot/cloud-init \
  /var/lib/virtpilot/backups
chown -R "${SERVICE_USER}:${SERVICE_USER}" /var/lib/virtpilot
chmod 750 /var/lib/virtpilot

# QEMU runs as libvirt-qemu (uid 64055 on Ubuntu). For it to open VM disks at
# /var/lib/virtpilot/vms/<name>/disk.qcow2 it must be able to traverse the
# 750-mode storage tree owned by ${SERVICE_USER}. Adding libvirt-qemu to the
# ${SERVICE_USER} group grants the group r-x bit (traverse); libvirt's
# dynamic_ownership still chowns the disk file itself before starting the VM.
# Without this, a clean install fails the first VM start with:
#   "Cannot access storage file ... (as uid:64055, gid:994): Permission denied"
# libvirtd caches supplementary groups at startup, so it must be restarted for
# the new membership to take effect on subsequently-forked qemu processes.
if id -u libvirt-qemu >/dev/null 2>&1; then
  usermod -aG "${SERVICE_USER}" libvirt-qemu
  systemctl restart libvirtd
fi
log "Storage ready"

# Ownership of the install dir — the service needs to write update logs and
# the dashboard self-upgrade needs to git-pull and npm-ci.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ─── TLS self-signed certificate ──────────────────────────────────────────────
TLS_DIR="/var/lib/virtpilot/tls"
mkdir -p "${TLS_DIR}"
chmod 700 "${TLS_DIR}"

if [[ ! -f "${TLS_DIR}/cert.pem" || ! -f "${TLS_DIR}/key.pem" ]]; then
  HOST_NAME="$(hostname -f 2>/dev/null || hostname)"
  PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  PRIMARY_IP="${PRIMARY_IP:-127.0.0.1}"
  # CN must be a real hostname — `CN=test` (the previous default in some
  # environments) makes browser warnings even less informative than they
  # already are. If hostname is empty, fall back to the primary IP.
  if [[ -z "${HOST_NAME}" || "${HOST_NAME}" == "test" ]]; then
    HOST_NAME="${PRIMARY_IP}"
  fi
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
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${TLS_DIR}"
  log "TLS certificate generated at ${TLS_DIR}/"
else
  log "TLS certificate already present — leaving in place"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${TLS_DIR}"
fi

# ─── Password setup ───────────────────────────────────────────────────────────
# Allow non-interactive installs via env var: VP_PASSWORD=secret sudo -E bash install.sh
if [[ -n "${VP_PASSWORD:-}" ]]; then
  if [[ ${#VP_PASSWORD} -lt 8 ]]; then
    die "VP_PASSWORD must be at least 8 characters."
  fi
  log "Using VP_PASSWORD from environment"
else
  if [[ ! -r /dev/tty ]]; then
    die "No TTY available for password prompt. Either run install.sh from an interactive shell, or pass VP_PASSWORD=... in the environment."
  fi
  echo ""
  echo -e "${BOLD}Set a login password for the VirtPilot web UI:${NC}"
  while true; do
    read -rsp "  Password : " VP_PASSWORD < /dev/tty; echo
    if [[ ${#VP_PASSWORD} -lt 8 ]]; then
      warn "Password must be at least 8 characters. Try again."
      continue
    fi
    read -rsp "  Confirm  : " VP_PASSWORD2 < /dev/tty; echo
    if [[ "$VP_PASSWORD" == "$VP_PASSWORD2" ]]; then
      break
    fi
    warn "Passwords do not match. Try again."
  done
  echo ""
fi

# Hash the password so the .env never contains plaintext credentials. We use
# the same scrypt format the backend's password.ts module uses (parsed back at
# runtime). Doing the hashing here means the plaintext lives only in this
# script's memory — never on disk.
info "Hashing login password..."
AUTH_PASSWORD_HASH="$(VP_PWD="${VP_PASSWORD}" node -e '
const { scryptSync, randomBytes } = require("crypto");
const pwd = process.env.VP_PWD;
const salt = randomBytes(16);
const N = 16384, r = 8, p = 1;
const derived = scryptSync(pwd, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
process.stdout.write(`scrypt$N=${N},r=${r},p=${p}$${salt.toString("hex")}$${derived.toString("hex")}`);
')"
unset VP_PASSWORD VP_PASSWORD2

# ─── Generate JWT and at-rest encryption secrets ────────────────────────────
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# ─── Write .env ───────────────────────────────────────────────────────────────
info "Writing configuration..."
ENV_FILE="${INSTALL_DIR}/packages/backend/.env"
cat > "${ENV_FILE}" << EOF
PORT=3001
NODE_ENV=production
# When nginx fronts the backend (PORT is changed to ${BACKEND_PORT} below in
# that flow), keep the listener on 127.0.0.1 so only nginx can reach it. If
# you opt out of nginx, BIND_ADDRESS is rewritten to 0.0.0.0 so the dashboard
# stays reachable on :${PUBLIC_PORT}.
BIND_ADDRESS=127.0.0.1

STORAGE_ROOT=/var/lib/virtpilot
TEMPLATES_DIR=/var/lib/virtpilot/templates
ISOS_DIR=/var/lib/virtpilot/isos
VMS_DIR=/var/lib/virtpilot/vms
CLOUD_INIT_DIR=/var/lib/virtpilot/cloud-init
# To store backups on a separate disk or NFS mount, set BACKUP_ROOT:
# BACKUP_ROOT=/mnt/nfs/virtpilot-backups

DEFAULT_BRIDGE=br0
LIBVIRT_URI=qemu:///system

# Repo path — used by the in-dashboard self-upgrade to locate update.sh
VIRTPILOT_REPO_DIR=${INSTALL_DIR}

# Comma-separated list of extra browser origins permitted by CORS. Empty means
# same-origin only (correct when the SPA is served by this backend).
ALLOWED_ORIGINS=

AUTH_PASSWORD_HASH=${AUTH_PASSWORD_HASH}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
EOF
chown "${SERVICE_USER}:${SERVICE_USER}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
log "Configuration written"

# ─── Reverse proxy (nginx) ────────────────────────────────────────────────────
# nginx fronts the dashboard on the public port (3001 by default — same as
# before) using the self-signed cert we just generated. The Node backend stays
# bound to 127.0.0.1 on an internal port (3002) and never touches the public
# network. Same URL the operator already uses (https://host:3001), with all
# the usual benefits of having a real reverse proxy in the request path.
#
# Ports 80 and 443 are intentionally left alone.

if [[ -n "${VP_NGINX:-}" ]]; then
  INSTALL_NGINX="${VP_NGINX}"
elif [[ ! -r /dev/tty ]]; then
  INSTALL_NGINX="no"
else
  echo ""
  echo -e "${BOLD}Reverse proxy (nginx)${NC}"
  echo "  nginx will listen on port ${PUBLIC_PORT} with the self-signed cert and"
  echo "  proxy to the Node backend on 127.0.0.1:${BACKEND_PORT}. Ports 80 and 443"
  echo "  are not touched."
  echo ""
  echo "  Skipping leaves the backend reachable directly on 0.0.0.0:${PUBLIC_PORT}"
  echo "  with its own self-signed TLS — same as before."
  echo ""
  while true; do
    read -rp "  Set up nginx? [Y/n] " ans < /dev/tty
    case "${ans:-Y}" in
      Y|y) INSTALL_NGINX="yes"; break ;;
      N|n) INSTALL_NGINX="no"; break ;;
      *)   warn "Please answer Y or n." ;;
    esac
  done
fi

if [[ "${INSTALL_NGINX}" == "yes" ]]; then
  info "Installing nginx..."
  apt-get install -y -qq nginx

  # nginx (running as www-data) needs to read the private key.
  chgrp www-data "${TLS_DIR}/key.pem"
  chmod 640 "${TLS_DIR}/key.pem"

  info "Writing VirtPilot nginx site..."
  cat > /etc/nginx/sites-available/virtpilot << NGINXSITE
# VirtPilot — managed by install.sh
# Public TLS termination on ${PUBLIC_PORT}; backend on 127.0.0.1:${BACKEND_PORT}.

server {
    listen ${PUBLIC_PORT} ssl http2;
    listen [::]:${PUBLIC_PORT} ssl http2;
    server_name _;

    ssl_certificate ${TLS_DIR}/cert.pem;
    ssl_certificate_key ${TLS_DIR}/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:VirtPilotSSL:10m;
    ssl_session_tickets off;

    # ISO and template uploads can be 50–100 GB.
    client_max_body_size 100G;

    # Don't buffer — required for streaming SSE (system upgrade output) and
    # chunked uploads/downloads. The dashboard has no traffic profile that
    # benefits from nginx buffering.
    proxy_buffering off;
    proxy_request_buffering off;

    # Console / SSH / VNC sessions can sit idle for a long time.
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;

    # WebSocket endpoints — need the Upgrade/Connection dance.
    location /ws/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        # \$http_host preserves the port (\$host strips it), so the backend's
        # CORS same-origin check sees the real Host the browser sent.
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        # \$http_host preserves the port (\$host strips it), so the backend's
        # CORS same-origin check sees the real Host the browser sent.
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINXSITE
  ln -sf /etc/nginx/sites-available/virtpilot /etc/nginx/sites-enabled/virtpilot

  # Pull nginx's default vhost off port 80 only if it's currently enabled —
  # don't clobber a config the operator might have already customised.
  rm -f /etc/nginx/sites-enabled/default

  if ! nginx -t >/dev/null 2>&1; then
    nginx -t || true
    die "nginx config validation failed. Check /etc/nginx/sites-available/virtpilot"
  fi

  systemctl enable --quiet nginx
  systemctl restart nginx
  log "nginx listening on :${PUBLIC_PORT} with the self-signed cert"

  # Move the backend off the public port and disable its own TLS — nginx
  # terminates TLS on ${PUBLIC_PORT}, the backend speaks plain HTTP locally.
  sed -i "s|^PORT=.*|PORT=${BACKEND_PORT}|" "${ENV_FILE}"
  sed -i 's|^TLS_CERT_PATH=.*|TLS_CERT_PATH=|' "${ENV_FILE}" || true
  sed -i 's|^TLS_KEY_PATH=.*|TLS_KEY_PATH=|' "${ENV_FILE}" || true
  grep -q '^TLS_CERT_PATH=' "${ENV_FILE}" || echo "TLS_CERT_PATH=" >> "${ENV_FILE}"
  grep -q '^TLS_KEY_PATH=' "${ENV_FILE}" || echo "TLS_KEY_PATH=" >> "${ENV_FILE}"

  # Firewall: allow public access to nginx, deny direct backend.
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow ${PUBLIC_PORT}/tcp >/dev/null 2>&1 || true
    ufw deny ${BACKEND_PORT}/tcp >/dev/null 2>&1 || true
    log "Opened ${PUBLIC_PORT}, denied ${BACKEND_PORT} in UFW"
  fi

  USE_NGINX=true
else
  warn "Skipping nginx setup."
  warn "  Backend will bind to 0.0.0.0:${PUBLIC_PORT} directly — ${BOLD}port ${PUBLIC_PORT} is reachable from the internet.${NC}"
  warn "  Run install.sh again with VP_NGINX=yes to add nginx in front later."
  sed -i 's|^BIND_ADDRESS=.*|BIND_ADDRESS=0.0.0.0|' "${ENV_FILE}"
  USE_NGINX=false
fi

# ─── Sudoers rules ────────────────────────────────────────────────────────────
# The service user needs to run a tiny set of privileged commands:
#  - iptables / ip link (firewall + bridge management)
#  - systemd-run / systemctl (self-upgrade orchestration)
#  - bash update.sh (the upgrade itself)
#  - qemu-img as libvirt-qemu (backup of running VMs — the disk file is chowned
#    to libvirt-qemu by libvirt's dynamic_ownership and mode 0600, so the
#    unprivileged service user cannot read it directly)
# Everything else stays under the unprivileged account. NOPASSWD because the
# service has no interactive session.
SUDOERS_FILE="/etc/sudoers.d/virtpilot"
info "Writing sudoers rules..."
cat > "${SUDOERS_FILE}" << EOF
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables, /sbin/iptables, /usr/sbin/ip, /sbin/ip
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/systemd-run, /bin/systemctl, /usr/bin/systemctl
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/journalctl
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/bash ${INSTALL_DIR}/update.sh
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/bin/apt, /usr/bin/apt-get
${SERVICE_USER} ALL=(libvirt-qemu) NOPASSWD: /usr/bin/qemu-img
EOF
chmod 0440 "${SUDOERS_FILE}"
visudo -cf "${SUDOERS_FILE}" >/dev/null
log "Sudoers rules installed"

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
User=${SERVICE_USER}
Group=${SERVICE_USER}
# libvirt for virsh/qemu. kvm for /dev/kvm device access. systemd-journal so
# the in-app self-upgrade can stream the unit's journal output. iptables/ip
# get CAP_NET_ADMIN as an ambient capability rather than going via sudo.
SupplementaryGroups=libvirt kvm systemd-journal
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW
# CapabilityBoundingSet is deliberately NOT pinned. A bounding set tighter
# than the caps sudo needs (CAP_SETUID, CAP_SETGID, CAP_AUDIT_WRITE) breaks
# every sudo invocation with `unable to change to root gid` + audit plugin
# init failure, including the (libvirt-qemu) qemu-img path used by backups.
# The blast-radius argument is illusory here — the service already has sudo
# rights to apt-get/systemctl per /etc/sudoers.d/virtpilot, which is strictly
# more powerful than any cap a hostile exec could gain. The real isolation
# is ProtectSystem=strict + ProtectKernel* + ReadWritePaths below.
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/packages/backend/dist/index.js
EnvironmentFile=${INSTALL_DIR}/packages/backend/.env
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=virtpilot

# Hardening — limits the blast radius if the backend is ever exploited. We
# deliberately do NOT set NoNewPrivileges here: the in-app self-upgrade and
# `apt upgrade` flows shell out to `sudo systemd-run` / `sudo apt-get`, and
# the kernel's no_new_privs bit makes sudo refuse to elevate even with the
# NOPASSWD rules in /etc/sudoers.d/virtpilot. The other hardening below all
# stays in force.
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
RestrictNamespaces=true
SystemCallArchitectures=native
# The service legitimately needs to read /var/lib/virtpilot and the install
# dir, and to write update logs. Everything else is read-only.
ReadWritePaths=/var/lib/virtpilot ${INSTALL_DIR}

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
echo -e "  ${BOLD}Web UI:${NC}      ${CYAN}https://${HOST_IP}:${PUBLIC_PORT}${NC}"
echo -e "  ${BOLD}Password:${NC}    the one you just set"
echo ""
echo -e "  ${YELLOW}Note:${NC} The TLS certificate is self-signed, so your browser will"
echo -e "        warn on first visit. Click \"Advanced → Proceed\" to continue."
echo ""
if [[ "${USE_NGINX}" == "true" ]]; then
  echo -e "  ${BOLD}Front:${NC} nginx on :${PUBLIC_PORT} (TLS) → backend 127.0.0.1:${BACKEND_PORT} (HTTP)"
else
  echo -e "  ${YELLOW}Heads up:${NC} nginx wasn't installed, so the backend serves directly on"
  echo -e "        :${PUBLIC_PORT}. Re-run install.sh with VP_NGINX=yes to add it later."
fi
echo ""
echo -e "  ${BOLD}Useful commands:${NC}"
echo -e "    systemctl status virtpilot"
echo -e "    journalctl -u virtpilot -f"
echo -e "    systemctl restart virtpilot"
if [[ "${USE_NGINX}" == "true" ]]; then
  echo -e "    systemctl reload nginx          # after editing /etc/nginx/sites-available/virtpilot"
  echo -e "    nginx -t                        # validate nginx config"
fi
echo ""
