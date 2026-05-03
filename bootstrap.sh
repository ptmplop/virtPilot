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

# Pin to the latest published release by default. Operators can override with
# VP_REF=main for development checkouts, or VP_REF=v1.20.0 for a specific
# version. Pinning means a compromise of `main` doesn't auto-deploy to every
# new install — you have to explicitly opt in to a tag that's been signed off.
VP_REF="${VP_REF:-}"

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

# ─── Ensure git + curl/jq are present ────────────────────────────────────────
need_install=()
command -v git >/dev/null 2>&1 || need_install+=(git)
command -v curl >/dev/null 2>&1 || need_install+=(curl)
command -v jq >/dev/null 2>&1 || need_install+=(jq)
if [[ ${#need_install[@]} -gt 0 ]]; then
  info "Installing prerequisites: ${need_install[*]}..."
  apt-get update -qq
  apt-get install -y -qq "${need_install[@]}"
fi

# ─── Resolve the ref to deploy ───────────────────────────────────────────────
if [[ -z "${VP_REF}" ]]; then
  info "Resolving latest VirtPilot release..."
  if VP_REF="$(curl -fsSL --max-time 15 \
      'https://api.github.com/repos/ptmplop/virtPilot/releases/latest' \
      | jq -r '.tag_name')" && [[ -n "${VP_REF}" && "${VP_REF}" != "null" ]]; then
    log "Will check out ${VP_REF} (latest release)"
  else
    die "Failed to resolve the latest release tag. Set VP_REF=v<version> manually, or VP_REF=main to track main."
  fi
else
  log "Using VP_REF=${VP_REF}"
fi

# ─── Clone or update ──────────────────────────────────────────────────────────
# After v1.21.0 install.sh chowns the repo to the unprivileged virtpilot user,
# so when we re-run as root git refuses to operate on it ("dubious ownership").
# Pass safe.directory inline via `-c` on every invocation — that's immune to
# whatever HOME resolution happens under `curl | sudo bash` (a `git config
# --global` write under that flow can land somewhere git won't read back).
GIT_SAFE=(git -c "safe.directory=${INSTALL_DIR}")
# Also persist it where future tooling will look, best-effort.
git config --system --add safe.directory "${INSTALL_DIR}" 2>/dev/null || true

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  info "Existing clone found at ${INSTALL_DIR} — fetching..."
  cd "${INSTALL_DIR}"
  "${GIT_SAFE[@]}" fetch --quiet --tags origin
  "${GIT_SAFE[@]}" reset --hard --quiet "${VP_REF}"
  log "Updated to $("${GIT_SAFE[@]}" rev-parse --short HEAD) (${VP_REF})"
elif [[ -e "${INSTALL_DIR}" ]]; then
  die "${INSTALL_DIR} exists but is not a git clone — refusing to overwrite. Move or remove it and re-run."
else
  info "Cloning ${REPO_URL} → ${INSTALL_DIR}..."
  git clone --quiet "${REPO_URL}" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
  "${GIT_SAFE[@]}" fetch --quiet --tags
  "${GIT_SAFE[@]}" checkout --quiet "${VP_REF}"
  log "Cloned and checked out ${VP_REF}"
fi

# ─── Hand off to installer ────────────────────────────────────────────────────
cd "${INSTALL_DIR}"
exec bash install.sh "$@"
