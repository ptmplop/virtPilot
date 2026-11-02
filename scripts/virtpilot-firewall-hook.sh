#!/bin/sh
# Installed as /etc/libvirt/hooks/qemu.d/virtpilot-firewall. Puts a VM's firewall in place as it
# starts, when its tap devices exist and QEMU doesn't yet, so it never runs a moment without one. At
# boot libvirt starts autostart VMs before VirtPilot's backend is up, and nothing else can cover that.
#
# libvirt waits for this and passes the VM's definition on stdin. It must never call back into
# libvirt, and a failure here would stop the VM starting, which isn't for a firewall hook to decide:
# it always exits 0, within a limit, and the backend's regular check puts right anything that failed.
# It runs as root, so it runs nothing of the service's: only nft and iptables-restore, on files the
# backend writes ready-made beside each VM's rules, which can't run code. libvirt only looks for
# hooks when it starts, so a new install of this takes effect from then.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
DIR='@CLOUD_INIT_DIR@'
T='bridge virtpilot'

if [ "$1" = --load ]; then
  xml=$(cat)
  uuid=$(printf '%s\n' "$xml" | sed -n 's/^ *<uuid>\([0-9a-f-]\{36\}\)<\/uuid> *$/\1/p' | head -n 1)
  [ -n "$uuid" ] || exit 0
  short=$(printf '%s' "$uuid" | tr -d '-' | cut -c1-8)
  # The tap of each NIC, and nothing else that has a target.
  taps=$(printf '%s\n' "$xml" | awk '/<interface[ >]/ { i = 1 } i && match($0, /<target dev=.[A-Za-z0-9._-]+./) { print substr($0, RSTART + 13, RLENGTH - 14) } /<\/interface>/ { i = 0 }')
  # Each file only as a file of its own: not through a link, which would have root read whatever
  # it points at, and nft is told nothing that has it read another. What the tools say isn't
  # passed on either, as it can quote what they read.
  ipt="$DIR/$uuid-firewall.boot.ipt"
  nftf="$DIR/$uuid-firewall.boot.nft"
  if [ -f "$ipt" ] && [ ! -L "$ipt" ] && ! iptables -w 5 -S "VP-IN-$short" >/dev/null 2>&1; then
    dd if="$ipt" iflag=nofollow status=none 2>/dev/null | iptables-restore -w 5 --noflush >/dev/null 2>&1 \
      || echo "could not put back the routed rules of VM $uuid"
  fi
  script=$(mktemp) || exit 0
  if [ -f "$nftf" ] && [ ! -L "$nftf" ]; then
    dd if="$nftf" iflag=nofollow status=none 2>/dev/null > "$script"
    if grep -q include "$script"; then
      echo "skipped the bridge rules of VM $uuid: they name another file"
      : > "$script"
    else
      # The host's addresses now, which may not be what they were when that file was written.
      echo "flush set $T host_v4" >> "$script"
      for a in $(ip -4 -o addr show | awk '$4 !~ /^127\./ { split($4, p, "/"); print p[1] }'); do
        echo "add element $T host_v4 { $a }" >> "$script"
      done
      for t in $taps; do
        printf 'destroy element %s to_vm { "%s" }\ndestroy element %s from_vm { "%s" }\n' "$T" "$t" "$T" "$t" >> "$script"
        printf 'add element %s to_vm { "%s" : jump vp-in-%s }\nadd element %s from_vm { "%s" : jump vp-out-%s }\n' "$T" "$t" "$short" "$T" "$t" "$short" >> "$script"
      done
    fi
  elif nft list table bridge virtpilot >/dev/null 2>&1; then
    # No firewall of its own: its taps' names are still taken off whoever had them last.
    for t in $taps; do
      printf 'destroy element %s to_vm { "%s" }\ndestroy element %s from_vm { "%s" }\n' "$T" "$t" "$T" "$t" >> "$script"
    done
  fi
  if [ -s "$script" ]; then
    nft -f "$script" >/dev/null 2>&1 || echo "could not put the bridge rules of VM $uuid in place"
  fi
  rm -f "$script"
  exit 0
fi

if [ "$2" != start ] || [ "$3" != begin ]; then
  cat >/dev/null
  exit 0
fi
timeout 20 "$0" --load 2>&1 | timeout 5 logger -t virtpilot-firewall
exit 0
