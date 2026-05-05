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

# Force the working tree onto origin/main, regardless of how the host got into
# its current state. The previous `git pull --ff-only` flow assumed the repo
# was on a tracking branch — but bootstrap.sh pins fresh installs to the
# latest release tag (`git checkout v<release>` → detached HEAD), and
# `npm install` below rewrites package-lock.json on every run. Either alone
# blocks `pull --ff-only`. A hard reset to origin/main recovers from:
#   • detached HEAD from the bootstrap pin
#   • tracked-file drift (package-lock.json, anything edited in place)
#   • a stale local `main` branch that diverged from origin
# Operator state lives outside git (STORAGE_ROOT, .env, .ssh/, node_modules)
# and is therefore untouched. Per CLAUDE.md this is not a dev checkout, so
# discarding tracked-file edits is the right behaviour.
"${GIT_SAFE[@]}" fetch --tags --prune origin

if ! "${GIT_SAFE[@]}" show-ref --verify --quiet refs/remotes/origin/main; then
  die "origin/main not found — remote unreachable or repository misconfigured"
fi

BEFORE=$("${GIT_SAFE[@]}" rev-parse HEAD)

CURRENT=$("${GIT_SAFE[@]}" symbolic-ref --short --quiet HEAD || echo "(detached)")
if [[ "$CURRENT" != "main" ]]; then
  warn "On '$CURRENT' (expected 'main') — switching back to main"
fi
"${GIT_SAFE[@]}" checkout -B main origin/main >/dev/null 2>&1
"${GIT_SAFE[@]}" reset --hard origin/main >/dev/null

AFTER=$("${GIT_SAFE[@]}" rev-parse HEAD)

# Compare what's on disk in source vs. what was last built. The build step
# writes packages/{backend,frontend}/dist/.version on every successful build,
# so a mismatch means dist/ is stale relative to source — even when no new
# commits were fetched (e.g. an operator hand-rolled the source forward, or
# a previous update.sh aborted between `git reset --hard` and `npm run build`
# leaving a half-applied state). Without this check, the early-exit below
# would silently skip the rebuild and the dashboard's "wait for backend"
# poll would time out: source says v2.3.4, running service still on v2.3.2.
SOURCE_VERSION=$(node -p "require('${INSTALL_DIR}/packages/backend/package.json').version" 2>/dev/null || echo unknown-source)
BUILT_VERSION=$(tr -d '[:space:]' < "${INSTALL_DIR}/packages/backend/dist/.version" 2>/dev/null || echo unbuilt)

if [[ "$BEFORE" == "$AFTER" ]]; then
  if [[ "$FORCE" == true ]]; then
    warn "Already up to date — rebuilding anyway (--force)"
  elif [[ "$SOURCE_VERSION" == "$BUILT_VERSION" ]]; then
    log "Already up to date ($("${GIT_SAFE[@]}" rev-parse --short HEAD), built v${BUILT_VERSION})"
    exit 0
  else
    warn "Source unchanged but built artefacts (${BUILT_VERSION}) lag source (v${SOURCE_VERSION}) — rebuilding"
  fi
else
  log "Updated $("${GIT_SAFE[@]}" rev-parse --short "$BEFORE") → $("${GIT_SAFE[@]}" rev-parse --short "$AFTER")"
  "${GIT_SAFE[@]}" log --oneline "${BEFORE}..${AFTER}"
  echo ""
fi

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
UNIT_CHANGED=false
if [[ -f "${UNIT_FILE}" ]] && grep -q '^NoNewPrivileges=' "${UNIT_FILE}"; then
  info "Removing NoNewPrivileges= from ${UNIT_FILE} (broke sudo-based upgrade flow)"
  sed -i '/^NoNewPrivileges=/d' "${UNIT_FILE}"
  UNIT_CHANGED=true
fi
# Pre-v1.21.10 installs pinned CapabilityBoundingSet to {CAP_NET_ADMIN,
# CAP_NET_RAW}. That bounding set strips CAP_SETUID/CAP_SETGID/CAP_AUDIT_WRITE
# from setuid sudo when it execs, so every sudo invocation (including the new
# libvirt-qemu path used by backups) fails with "unable to change to root gid".
if [[ -f "${UNIT_FILE}" ]] && grep -q '^CapabilityBoundingSet=' "${UNIT_FILE}"; then
  info "Removing CapabilityBoundingSet= from ${UNIT_FILE} (broke sudo)"
  sed -i '/^CapabilityBoundingSet=/d' "${UNIT_FILE}"
  UNIT_CHANGED=true
fi
# Pre-v1.21.11 installs had RestrictSUIDSGID=true. Per systemd.exec(5) that
# directive "implies NoNewPrivileges=yes, ignoring the value of [the explicit
# NoNewPrivileges] setting" — so the v1.21.8 fix that removed the explicit
# NoNewPrivileges=true line was a no-op: the kernel no_new_privs bit was
# still being set by RestrictSUIDSGID, which is why sudo continued to fail
# with "unable to change to root gid" even after CapabilityBoundingSet was
# also dropped in v1.21.10. Strip it.
if [[ -f "${UNIT_FILE}" ]] && grep -q '^RestrictSUIDSGID=' "${UNIT_FILE}"; then
  info "Removing RestrictSUIDSGID= from ${UNIT_FILE} (silently implied NoNewPrivileges)"
  sed -i '/^RestrictSUIDSGID=/d' "${UNIT_FILE}"
  UNIT_CHANGED=true
fi
if [[ "${UNIT_CHANGED}" == true ]]; then
  systemctl daemon-reload
  log "Unit file healed"
fi

# ─── Heal sudoers rules (idempotent) ─────────────────────────────────────────
# Pre-v1.21.9 sudoers had no rule for qemu-img, so backup of any VM that had
# ever been running failed with EACCES (libvirt's dynamic_ownership had
# chowned the disk to libvirt-qemu mode 0600). Add the missing rule if absent.
SUDOERS_FILE="/etc/sudoers.d/virtpilot"
if [[ -f "${SUDOERS_FILE}" ]] && ! grep -q 'libvirt-qemu.*qemu-img' "${SUDOERS_FILE}"; then
  info "Adding qemu-img sudoers rule (backups of running VMs)"
  echo "${SERVICE_USER} ALL=(libvirt-qemu) NOPASSWD: /usr/bin/qemu-img" >> "${SUDOERS_FILE}"
  chmod 0440 "${SUDOERS_FILE}"
  visudo -cf "${SUDOERS_FILE}" >/dev/null
  log "Sudoers rules healed"
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
