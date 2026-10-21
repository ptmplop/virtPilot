#!/usr/bin/env bash
# VirtPilot passthrough helper. Installed as /usr/local/sbin/virtpilot-passthrough
# (root:root 0755) by install.sh and update.sh, and run as root: by the
# backend through `systemd-run` (the service's own sandbox makes /sys
# read-only, so it can't write these files itself), and at boot by
# virtpilot-passthrough.service, before libvirt starts any VM.
#
#   keep <pci-address>       bind to vfio-pci now and at every boot
#   release <pci-address>    give the device back to its host driver
#   vfs <pci-address> <n>    switch a card to n SR-IOV virtual functions (0 = off)
#   apply                    re-apply everything above (boot)
#   reset                    release everything and switch virtual functions off (uninstall)
#   status                   print the saved settings
#
# Settings live in /etc/virtpilot/passthrough.conf, one per line, each with the
# card's vendor:device so a line never applies to a different card that has
# since taken its address (cards added or moved renumber the bus):
#   keep 0000:3b:00.0 10de:27b8
#   vfs 0000:5e:00.0 4 15b3:a2dc
#
# Functions report failure by returning 1, never by exiting: at boot one bad
# line must not stop the others. Only the command dispatch at the bottom exits.
set -uo pipefail

CONF_DIR=/etc/virtpilot
CONF="${CONF_DIR}/passthrough.conf"
PCI=/sys/bus/pci/devices
ADDR_RE='^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$'
IDS_RE='^[0-9a-f]{4}:[0-9a-f]{4}$'

fail() { echo "$*" >&2; return 1; }

valid_address() {
  [[ "$1" =~ $ADDR_RE ]] || fail "Not a PCI address: $1"
}

present() {
  [[ -d "${PCI}/$1" ]]
}

driver_of() {
  if [[ -e "${PCI}/$1/driver" ]]; then
    basename "$(readlink -f "${PCI}/$1/driver")"
  fi
}

ids_of() {
  local v d
  v="$(cat "${PCI}/$1/vendor" 2>/dev/null)" || return 1
  d="$(cat "${PCI}/$1/device" 2>/dev/null)" || return 1
  echo "${v#0x}:${d#0x}"
}

# The card at an address is still the one the line was written for.
same_card() {
  local addr="$1" ids="$2"
  [[ -z "${ids}" ]] && return 0
  [[ "${ids}" =~ $IDS_RE ]] || { fail "Skipping ${addr}: unreadable card IDs in the settings (${ids})."; return 1; }
  [[ "$(ids_of "${addr}")" == "${ids}" ]] || fail "Skipping ${addr}: it now holds a different card ($(ids_of "${addr}"), not ${ids})."
}

conf_lines() {
  if [[ -f "${CONF}" ]]; then grep -E '^(keep|vfs) ' "${CONF}" || true; fi
}

conf_write() {
  # $1: the full new contents
  mkdir -p "${CONF_DIR}" && chmod 0755 "${CONF_DIR}" || return 1
  local tmp
  tmp="$(mktemp "${CONF_DIR}/.passthrough.XXXXXX")" || return 1
  printf '%s' "$1" > "${tmp}" && chmod 0644 "${tmp}" && mv -f "${tmp}" "${CONF}"
}

# Is sysfs path $2 at or below PCI device path $1?
under() {
  [[ "$2" == "$1" || "$2" == "$1"/* ]]
}

# The host's own disks and network, refused here even though the backend
# already refuses them: this script is the last thing between a click (or a
# boot) and the host losing its root filesystem or the address it is managed on.
refuse_host_critical() {
  local addr="$1" real header src dev
  real="$(readlink -f "${PCI}/${addr}")"

  # Header type 1 or 2: a bridge, which VFIO never needs.
  header="$(od -An -t x1 -j 14 -N 1 "${PCI}/${addr}/config" 2>/dev/null | tr -d ' \n')"
  if [[ -n "${header}" ]] && (( (0x${header} & 0x7f) == 1 || (0x${header} & 0x7f) == 2 )); then
    fail "${addr} is a bridge, not a device to pass through."; return 1
  fi

  # A disk behind this device that holds a mounted filesystem, walking down through
  # dm/md layers to the physical disks.
  while read -r src; do
    [[ "${src}" == /dev/* ]] || continue
    dev="$(basename "$(readlink -f "${src}")")"
    [[ -e "/sys/class/block/${dev}" ]] || continue
    local stack=("${dev}") seen="" cur p s c
    while ((${#stack[@]})); do
      cur="${stack[-1]}"; unset 'stack[-1]'
      [[ " ${seen} " == *" ${cur} "* ]] && continue
      seen+=" ${cur}"
      local slaves=(/sys/class/block/"${cur}"/slaves/*)
      if [[ -e "${slaves[0]}" ]]; then
        for s in "${slaves[@]}"; do stack+=("$(basename "${s}")"); done
        continue
      fi
      p="$(readlink -f "/sys/class/block/${cur}")"
      # A partition's disk is its parent directory.
      [[ -e "${p}/partition" ]] && p="$(dirname "${p}")"
      if under "${real}" "${p}"; then
        fail "${addr} holds a disk the host has mounted (${src}). It can't be kept for VMs."; return 1
      fi
      # Native NVMe multipath: the namespace sits under a virtual nvme-subsystem
      # directory, and its controllers are the nvmeN links beside it.
      if [[ "${p}" == */nvme-subsystem/* ]]; then
        for c in "$(dirname "${p}")"/nvme[0-9]*; do
          [[ -L "${c}" ]] || continue
          if under "${real}" "$(readlink -f "${c}")"; then
            fail "${addr} reaches a disk the host has mounted (${src}). It can't be kept for VMs."; return 1
          fi
        done
      fi
    done
  done < <(awk '{print $1}' /proc/self/mounts | sort -u)

  # The interface carrying the default route.
  local ifname devpath
  for ifname in $(ip -o route show default 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="dev") print $(i+1)}' | sort -u); do
    devpath="$(readlink -f "/sys/class/net/${ifname}/device" 2>/dev/null || true)"
    if [[ -n "${devpath}" ]] && under "${real}" "${devpath}"; then
      fail "${addr} carries the host's default route (${ifname}). It can't be kept for VMs."; return 1
    fi
  done
  return 0
}

group_in_use() {
  local addr="$1" group fd
  group="$(basename "$(readlink -f "${PCI}/${addr}/iommu_group")")"
  [[ -e "/dev/vfio/${group}" ]] || return 1
  for fd in /proc/[0-9]*/fd/*; do
    if [[ "$(readlink "${fd}" 2>/dev/null)" == "/dev/vfio/${group}" ]]; then return 0; fi
  done
  return 1
}

bind_vfio() {
  local addr="$1" drv
  present "${addr}" || { echo "Skipping ${addr}: not on this host." >&2; return 0; }
  modprobe vfio-pci || { fail "Could not load vfio-pci."; return 1; }
  echo vfio-pci > "${PCI}/${addr}/driver_override" || return 1
  drv="$(driver_of "${addr}")"
  if [[ -n "${drv}" && "${drv}" != vfio-pci ]]; then
    echo "${addr}" > "${PCI}/${addr}/driver/unbind" || return 1
  fi
  if [[ "$(driver_of "${addr}")" != vfio-pci ]]; then
    echo "${addr}" > /sys/bus/pci/drivers_probe 2>/dev/null
  fi
  [[ "$(driver_of "${addr}")" == vfio-pci ]] || { fail "${addr} did not bind to vfio-pci."; return 1; }
}

unbind_vfio() {
  local addr="$1"
  present "${addr}" || return 0
  if group_in_use "${addr}"; then
    fail "${addr} is in use by a running VM. Stop the VM first."; return 1
  fi
  echo > "${PCI}/${addr}/driver_override" || return 1
  if [[ "$(driver_of "${addr}")" == vfio-pci ]]; then
    echo "${addr}" > "${PCI}/${addr}/driver/unbind" || return 1
    echo "${addr}" > /sys/bus/pci/drivers_probe 2>/dev/null || true
  fi
  return 0
}

# $3, when set, is how long to wait for the card's own driver: at boot udev may not
# have bound it yet, and the kernel only accepts sriov_numvfs from a bound driver.
set_vfs() {
  local addr="$1" want="$2" wait="${3:-0}" total now i
  present "${addr}" || { echo "Skipping ${addr}: not on this host." >&2; return 0; }
  [[ -e "${PCI}/${addr}/sriov_totalvfs" ]] || { fail "${addr} has no SR-IOV virtual functions."; return 1; }
  for ((i = 0; i < wait; i++)); do
    [[ -n "$(driver_of "${addr}")" ]] && break
    sleep 1
  done
  total="$(cat "${PCI}/${addr}/sriov_totalvfs")"
  (( want <= total )) || { fail "${addr} supports at most ${total} virtual functions."; return 1; }
  now="$(cat "${PCI}/${addr}/sriov_numvfs")"
  (( now == want )) && return 0
  # The kernel only goes from n to m through 0.
  if (( now > 0 )); then echo 0 > "${PCI}/${addr}/sriov_numvfs" || return 1; fi
  if (( want > 0 )); then echo "${want}" > "${PCI}/${addr}/sriov_numvfs" || return 1; fi
  return 0
}

apply_all() {
  local kind a n ids rc=0
  # Virtual functions first: a kept device can be one of them.
  while read -r kind a n ids; do
    [[ "${kind}" == vfs && "${a}" =~ $ADDR_RE && "${n}" =~ ^[0-9]+$ ]] || continue
    present "${a}" || { echo "Skipping ${a}: not on this host." >&2; continue; }
    if same_card "${a}" "${ids:-}" && set_vfs "${a}" "${n}" 30; then :; else echo "Could not set virtual functions on ${a}." >&2; rc=1; fi
  done < <(conf_lines)
  while read -r kind a ids _; do
    [[ "${kind}" == keep && "${a}" =~ $ADDR_RE ]] || continue
    present "${a}" || { echo "Skipping ${a}: not on this host." >&2; continue; }
    if same_card "${a}" "${ids:-}" && refuse_host_critical "${a}" && bind_vfio "${a}"; then :; else echo "Could not keep ${a} for VMs." >&2; rc=1; fi
  done < <(conf_lines)
  return "${rc}"
}

cmd="${1:-}"
case "${cmd}" in
  keep)
    addr="${2:-}"
    valid_address "${addr}" || exit 1
    present "${addr}" || { fail "${addr} is not on this host."; exit 1; }
    refuse_host_critical "${addr}" || exit 1
    bind_vfio "${addr}" || exit 1
    ids="$(ids_of "${addr}")"
    rest="$(conf_lines | grep -v -E "^keep ${addr//./\\.}( |$)" || true)"
    conf_write "$(printf '%s\nkeep %s %s\n' "${rest}" "${addr}" "${ids}" | sed '/^$/d')"$'\n' || exit 1
    echo "Kept ${addr} for VMs."
    ;;
  release)
    addr="${2:-}"
    valid_address "${addr}" || exit 1
    unbind_vfio "${addr}" || exit 1
    rest="$(conf_lines | grep -v -E "^keep ${addr//./\\.}( |$)" || true)"
    conf_write "${rest:+${rest}$'\n'}" || exit 1
    echo "Gave ${addr} back to the host."
    ;;
  vfs)
    addr="${2:-}"; count="${3:-}"
    valid_address "${addr}" || exit 1
    [[ "${count}" =~ ^[0-9]{1,4}$ ]] || { fail "Not a number of virtual functions: ${count}"; exit 1; }
    set_vfs "${addr}" "${count}" || exit 1
    ids="$(ids_of "${addr}")"
    rest="$(conf_lines | grep -v -E "^vfs ${addr//./\\.} " || true)"
    if (( count > 0 )); then
      conf_write "$(printf '%s\nvfs %s %s %s\n' "${rest}" "${addr}" "${count}" "${ids}" | sed '/^$/d')"$'\n' || exit 1
    else
      conf_write "${rest:+${rest}$'\n'}" || exit 1
    fi
    # Kept virtual functions come back with the same addresses.
    while read -r kind a _; do
      [[ "${kind}" == keep && "${a}" =~ $ADDR_RE ]] || continue
      if present "${a}" && [[ "$(driver_of "${a}")" != vfio-pci ]]; then bind_vfio "${a}" || true; fi
    done < <(conf_lines)
    echo "${addr} now has ${count} virtual function$([[ "${count}" == 1 ]] || echo s)."
    ;;
  apply)
    apply_all || exit 1
    ;;
  reset)
    while read -r kind a _; do
      [[ "${kind}" == keep && "${a}" =~ $ADDR_RE ]] || continue
      unbind_vfio "${a}" || true
    done < <(conf_lines)
    while read -r kind a _; do
      [[ "${kind}" == vfs && "${a}" =~ $ADDR_RE ]] || continue
      set_vfs "${a}" 0 || true
    done < <(conf_lines)
    rm -f "${CONF}"
    echo "Passthrough settings cleared."
    ;;
  status)
    conf_lines
    ;;
  *)
    fail "Usage: virtpilot-passthrough keep|release <pci-address> | vfs <pci-address> <count> | apply | reset | status"
    exit 1
    ;;
esac
