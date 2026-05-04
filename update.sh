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

# install.sh chowns the repo to the unprivileged virtpilot user. update.sh runs
# as root (via systemd-run from the dashboard), so git would refuse to touch
# the now-non-root-owned tree. Pass safe.directory inline via `-c` on every
# invocation — robust against whichever .gitconfig HOME ends up resolving to
# in the systemd-run environment.
GIT_SAFE=(git -c "safe.directory=$INSTALL_DIR")
git config --system --add safe.directory "$INSTALL_DIR" 2>/dev/null || true

# `npm install` below rewrites package-lock.json on the install host (e.g. adds
# linux-x64 binary entries that aren't in the macOS-generated lockfile). Discard
# that drift so the next `git pull --ff-only` doesn't abort on a dirty tree.
"${GIT_SAFE[@]}" checkout -- package-lock.json 2>/dev/null || true

BEFORE=$("${GIT_SAFE[@]}" rev-parse HEAD)
"${GIT_SAFE[@]}" pull --ff-only
AFTER=$("${GIT_SAFE[@]}" rev-parse HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
  if [[ "$FORCE" == true ]]; then
    warn "Already up to date — rebuilding anyway (--force)"
  else
    log "Already up to date ($("${GIT_SAFE[@]}" rev-parse --short HEAD))"
    exit 0
  fi
fi

log "Updated $("${GIT_SAFE[@]}" rev-parse --short "$BEFORE") → $("${GIT_SAFE[@]}" rev-parse --short "$AFTER")"
"${GIT_SAFE[@]}" log --oneline "${BEFORE}..${AFTER}"
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
  HOST_NAME="$(hostname -f 2>/dev/null || hostname)"
  PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  PRIMARY_IP="${PRIMARY_IP:-127.0.0.1}"
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
  log "TLS certificate generated at ${TLS_DIR}/"
fi
# If nginx is fronting the backend, the cert needs to be group-readable by www-data.
if [[ -e /etc/nginx/sites-enabled/virtpilot ]]; then
  chgrp www-data "${TLS_DIR}/key.pem" 2>/dev/null || true
  chmod 640 "${TLS_DIR}/key.pem"
fi

# ─── .env compat shim for installs that pre-date the v1.21 hardening ─────────
# Older .env files don't have BIND_ADDRESS at all. The new backend defaults to
# 127.0.0.1, which would silently make the dashboard unreachable on a public
# IP after upgrade. Detect the pre-1.21 layout and add the right defaults so
# the operator's existing access stays intact.
ENV_FILE="${INSTALL_DIR}/packages/backend/.env"
if [[ -f "${ENV_FILE}" ]] && ! grep -q '^BIND_ADDRESS=' "${ENV_FILE}"; then
  if [[ -e /etc/nginx/sites-enabled/virtpilot ]]; then
    info "Existing nginx site detected — pinning backend to 127.0.0.1:3002 plain HTTP"
    echo "BIND_ADDRESS=127.0.0.1" >> "${ENV_FILE}"
    sed -i 's|^PORT=.*|PORT=3002|' "${ENV_FILE}"
    sed -i 's|^TLS_CERT_PATH=.*|TLS_CERT_PATH=|' "${ENV_FILE}"
    sed -i 's|^TLS_KEY_PATH=.*|TLS_KEY_PATH=|' "${ENV_FILE}"
    grep -q '^TLS_CERT_PATH=' "${ENV_FILE}" || echo "TLS_CERT_PATH=" >> "${ENV_FILE}"
    grep -q '^TLS_KEY_PATH=' "${ENV_FILE}" || echo "TLS_KEY_PATH=" >> "${ENV_FILE}"
  else
    info "Preserving existing 0.0.0.0:3001 binding (no nginx detected)"
    echo "BIND_ADDRESS=0.0.0.0" >> "${ENV_FILE}"
  fi
fi

# ─── Dependencies ─────────────────────────────────────────────────────────────
# Run npm as the service user so installed packages match the runtime owner.
# Use `npm ci` when a lockfile is present so the lockfile is treated as
# authoritative — refuses to install if package.json drifts from the lock.
SERVICE_USER="${SERVICE_USER:-virtpilot}"
info "Installing npm dependencies (as ${SERVICE_USER})..."
if [[ -f package-lock.json ]]; then
  sudo -u "${SERVICE_USER}" npm ci --no-fund --no-audit
else
  sudo -u "${SERVICE_USER}" npm install --no-fund --no-audit
fi
# Re-fix ownership in case anything was created as root.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/node_modules" "${INSTALL_DIR}/packages" 2>/dev/null || true

# ─── Build ────────────────────────────────────────────────────────────────────
info "Building VirtPilot..."
sudo -u "${SERVICE_USER}" npm run build 2>&1
log "Build complete"

# ─── Heal systemd unit (idempotent) ──────────────────────────────────────────
# Pre-v1.21.8 installs shipped with NoNewPrivileges=true in the unit file, but
# the in-app self-upgrade and apt-upgrade flows both rely on `sudo systemd-run`
# / `sudo apt-get`, which the kernel's no_new_privs bit blocks regardless of
# the NOPASSWD sudoers rules. Strip the line if present so the next in-app
# upgrade actually works. daemon-reload picks up the change before the
# restart below.
UNIT_FILE="/etc/systemd/system/virtpilot.service"
if [[ -f "${UNIT_FILE}" ]] && grep -q '^NoNewPrivileges=' "${UNIT_FILE}"; then
  info "Removing NoNewPrivileges= from ${UNIT_FILE} (broke sudo-based upgrade flow)"
  sed -i '/^NoNewPrivileges=/d' "${UNIT_FILE}"
  systemctl daemon-reload
  log "Unit file healed"
fi

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
