#!/usr/bin/env bash
# Deliberately not `set -e` — uninstall must be best-effort. A half-installed
# system (e.g. install.sh failed mid-way, or earlier uninstall ran partially)
# should not block subsequent cleanup steps. Each step guards its own preconds.
set -uo pipefail

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
echo -e "${NC}${BOLD}  VirtPilot — Uninstaller${NC}\n"

# ─── Pre-flight checks ────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  die "Run this uninstaller as root: sudo bash uninstall.sh"
fi

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="virtpilot"
PUBLIC_PORT=3001
BACKEND_PORT=3002

# ─── Flags ────────────────────────────────────────────────────────────────────
ASSUME_YES=0
REMOVE_INSTALL_DIR=0
PURGE_DEPS=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --remove-install-dir) REMOVE_INSTALL_DIR=1 ;;
    --purge-deps) PURGE_DEPS=1 ;;
    -h|--help)
      cat << HELP
VirtPilot uninstaller

Usage: sudo bash uninstall.sh [options]

Options:
  -y, --yes              Skip the confirmation prompt
  --remove-install-dir   Also delete the project directory (${INSTALL_DIR})
  --purge-deps           Also purge apt packages installed by install.sh
                         (qemu-kvm, libvirt-daemon-system, nginx, swtpm, ovmf, ...)
  -h, --help             Show this help
HELP
      exit 0
      ;;
    *) die "Unknown argument: $arg (try --help)" ;;
  esac
done

# ─── Confirmation ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}This will remove:${NC}"
echo "  • virtpilot systemd service and unit file"
echo "  • All libvirt networks named virtpilot-* (defined by VirtPilot)"
echo "  • All libvirt VMs whose disks live under /var/lib/virtpilot/"
echo "  • iptables VP-IN-* / VP-OUT-* chains"
echo "  • /etc/nginx/sites-{available,enabled}/virtpilot"
echo "  • UFW rules for ports ${PUBLIC_PORT}/${BACKEND_PORT}"
echo "  • /etc/sudoers.d/virtpilot"
echo "  • The ${SERVICE_USER} system user"
echo "  • /var/lib/virtpilot (VM disks, ISOs, templates, backups, TLS cert)"
[[ ${REMOVE_INSTALL_DIR} -eq 1 ]] && echo "  • The install directory ${INSTALL_DIR}"
[[ ${PURGE_DEPS} -eq 1 ]]        && echo "  • apt packages: qemu-kvm, libvirt-*, virtinst, ovmf, swtpm*, genisoimage, bridge-utils, nginx"
echo ""

if [[ ${ASSUME_YES} -ne 1 ]]; then
  if [[ ! -r /dev/tty ]]; then
    die "No TTY available for confirmation prompt. Pass -y to skip."
  fi
  read -rp "Continue? Type 'yes' to confirm: " confirm < /dev/tty
  if [[ "${confirm}" != "yes" ]]; then
    die "Aborted."
  fi
fi

# ─── 1. Stop & remove systemd service ─────────────────────────────────────────
info "Stopping virtpilot service..."
systemctl stop virtpilot 2>/dev/null || true
systemctl disable virtpilot 2>/dev/null || true
if [[ -f /etc/systemd/system/virtpilot.service ]]; then
  rm -f /etc/systemd/system/virtpilot.service
  systemctl daemon-reload
  log "Removed virtpilot.service"
fi

# ─── 2. Remove VMs whose disks live under /var/lib/virtpilot/ ─────────────────
# We identify "VirtPilot VMs" by inspecting each domain's XML for a disk path
# under /var/lib/virtpilot/. This is more reliable than name patterns because
# users name their VMs freely. Domains using disks elsewhere are left alone.
if command -v virsh >/dev/null 2>&1; then
  info "Looking for VMs created by VirtPilot..."
  while IFS= read -r dom; do
    [[ -z "$dom" ]] && continue
    if virsh -c qemu:///system dumpxml "$dom" 2>/dev/null | grep -q "/var/lib/virtpilot/"; then
      info "  Removing VM: $dom"
      virsh -c qemu:///system destroy "$dom" 2>/dev/null || true
      # --nvram drops the per-domain UEFI vars file; --remove-all-storage drops
      # disks libvirt knows about. Fall back through the option set in case the
      # libvirt build doesn't support them all (older Ubuntu builds, etc.).
      virsh -c qemu:///system undefine --nvram --remove-all-storage "$dom" 2>/dev/null \
        || virsh -c qemu:///system undefine --nvram "$dom" 2>/dev/null \
        || virsh -c qemu:///system undefine "$dom" 2>/dev/null || true
    fi
  done < <(virsh -c qemu:///system list --all --name 2>/dev/null)

  # ─── 3. Remove virtpilot-* libvirt networks ─────────────────────────────────
  info "Removing virtpilot-* libvirt networks..."
  while IFS= read -r net; do
    [[ -z "$net" ]] && continue
    if [[ "$net" == virtpilot-* ]]; then
      info "  Removing network: $net"
      virsh -c qemu:///system net-destroy "$net" 2>/dev/null || true
      virsh -c qemu:///system net-autostart --disable "$net" 2>/dev/null || true
      virsh -c qemu:///system net-undefine "$net" 2>/dev/null || true
    fi
  done < <(virsh -c qemu:///system net-list --all --name 2>/dev/null)
fi

# ─── 4. Remove iptables VP-* chains ───────────────────────────────────────────
# The backend creates VP-IN-{vm} / VP-OUT-{vm} chains and references them from
# built-in chains (FORWARD etc.). Atomic approach: dump the ruleset, strip every
# line that mentions VP-IN- or VP-OUT- (chain declarations, rules inside them,
# and -j references), then restore. Cleaner than chasing -D rule-by-rule.
if command -v iptables >/dev/null 2>&1 \
   && iptables-save 2>/dev/null | grep -qE 'VP-(IN|OUT)-'; then
  info "Removing VirtPilot iptables chains..."
  TMP_RULES="$(mktemp)"
  if iptables-save 2>/dev/null | grep -vE 'VP-(IN|OUT)-' > "${TMP_RULES}"; then
    iptables-restore < "${TMP_RULES}" 2>/dev/null \
      || warn "iptables-restore failed; check iptables-save manually"
  fi
  rm -f "${TMP_RULES}"
  log "iptables VP-* chains removed"
fi

# ─── 5. nginx site ────────────────────────────────────────────────────────────
if [[ -L /etc/nginx/sites-enabled/virtpilot || -f /etc/nginx/sites-enabled/virtpilot ]]; then
  rm -f /etc/nginx/sites-enabled/virtpilot
fi
if [[ -f /etc/nginx/sites-available/virtpilot ]]; then
  rm -f /etc/nginx/sites-available/virtpilot
  log "Removed nginx site"
fi
if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx 2>/dev/null; then
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || true
  else
    warn "nginx config invalid after removal — left running, please inspect /etc/nginx"
  fi
fi

# ─── 6. UFW rules ─────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw delete allow ${PUBLIC_PORT}/tcp >/dev/null 2>&1 || true
  ufw delete deny  ${BACKEND_PORT}/tcp >/dev/null 2>&1 || true
fi

# ─── 7. sudoers ───────────────────────────────────────────────────────────────
rm -f /etc/sudoers.d/virtpilot

# ─── 8. Detach libvirt-qemu from the virtpilot group ──────────────────────────
# install.sh added libvirt-qemu to the ${SERVICE_USER} group so qemu could
# traverse the 750-mode storage tree. Drop that membership before deleting the
# group with userdel below; otherwise the group hangs around as a stale GID.
if id -u libvirt-qemu >/dev/null 2>&1 && id -nG libvirt-qemu 2>/dev/null | tr ' ' '\n' | grep -qx "${SERVICE_USER}"; then
  gpasswd -d libvirt-qemu "${SERVICE_USER}" >/dev/null 2>&1 || true
fi

# ─── 9. Remove the service user ───────────────────────────────────────────────
if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  # Best-effort kill of anything still running as the service user. The systemd
  # stop above should have caught the backend, but a stuck console pty or
  # leftover npm process from the build phase could still be holding the uid.
  pkill -u "${SERVICE_USER}" 2>/dev/null || true
  sleep 1
  pkill -9 -u "${SERVICE_USER}" 2>/dev/null || true
  userdel "${SERVICE_USER}" 2>/dev/null || true
  groupdel "${SERVICE_USER}" 2>/dev/null || true
  log "Removed ${SERVICE_USER} user"
fi

# ─── 10. /var/lib/virtpilot ───────────────────────────────────────────────────
if [[ -d /var/lib/virtpilot ]]; then
  rm -rf /var/lib/virtpilot
  log "Removed /var/lib/virtpilot"
fi

# ─── 11. Restart libvirtd ─────────────────────────────────────────────────────
# libvirtd cached the libvirt-qemu group memberships at startup. Restart so it
# forgets the now-deleted ${SERVICE_USER} group and doesn't log warnings about
# missing supplementary groups on subsequent VM starts.
if systemctl is-active --quiet libvirtd 2>/dev/null; then
  systemctl restart libvirtd 2>/dev/null || true
fi

# ─── 12. git safe.directory entry ─────────────────────────────────────────────
git config --global --unset-all safe.directory "${INSTALL_DIR}" 2>/dev/null || true

# ─── 13. (optional) Remove the install directory ──────────────────────────────
if [[ ${REMOVE_INSTALL_DIR} -eq 1 && -d "${INSTALL_DIR}" ]]; then
  # cd out before rm — bash holds this script open, but rm'ing the cwd that the
  # current shell still references makes some subsequent commands behave oddly.
  cd /
  rm -rf "${INSTALL_DIR}"
  log "Removed ${INSTALL_DIR}"
fi

# ─── 14. (optional) Purge apt deps ────────────────────────────────────────────
# Deliberately conservative: only the packages directly tied to running VMs
# and serving the dashboard. We do NOT purge curl/openssl/ca-certificates/
# gnupg/build-essential/python3 — those are general system packages the
# operator likely uses for other things, and yanking them can break the host.
# nodejs is also left alone for the same reason.
if [[ ${PURGE_DEPS} -eq 1 ]]; then
  info "Purging apt packages installed by VirtPilot..."
  DEBIAN_FRONTEND=noninteractive apt-get -y -qq purge \
    qemu-kvm libvirt-daemon-system libvirt-clients virtinst \
    ovmf swtpm swtpm-tools genisoimage bridge-utils nginx 2>/dev/null || true
  apt-get -y -qq autoremove 2>/dev/null || true
  log "Purged apt packages"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  VirtPilot has been uninstalled.${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
[[ ${REMOVE_INSTALL_DIR} -ne 1 ]] && echo -e "  Project directory left in place: ${CYAN}${INSTALL_DIR}${NC}"
if [[ ${PURGE_DEPS} -ne 1 ]]; then
  echo -e "  apt packages (qemu-kvm, libvirt-*, nginx, ...) left installed."
  echo -e "  Re-run with ${CYAN}--purge-deps${NC} to remove them."
fi
echo ""
