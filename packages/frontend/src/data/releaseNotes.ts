export type ChangeType = 'added' | 'changed' | 'fixed' | 'removed';

export interface Change {
  type: ChangeType;
  text: string;
}

export interface ReleaseEntry {
  version: string;
  date: string;
  changes: Change[];
}

export const releaseNotes: ReleaseEntry[] = [
  {
    version: '2.3.2',
    date: '2026-05-05',
    changes: [
      { type: 'added', text: 'Storage-directory ownership advisory. When you register a directory whose group is not virtpilot, the dashboard surfaces a warning toast at register time and an amber "warning" chip on the directory row. The chip\'s tooltip prints the exact chgrp/chmod command to fix it. libvirt-qemu (a member of the virtpilot group) needs to traverse the registered dir to read VM disks; without this advisory, mounting iSCSI/NFS without setting the right group fails with a cryptic "Permission denied" only when a VM tries to start. The check re-runs on every Storage-page refresh.' },
      { type: 'added', text: 'Explicit chown of created subdirs. When creating templates/ / isos/ / vms/ inside a registered storage dir, VirtPilot now chowns them to virtpilot:virtpilot after the mkdir + chmod 0770. No-op for fresh mkdir output but defends against parent dirs with the setgid bit set or unusual umasks.' },
    ],
  },
  {
    version: '2.3.1',
    date: '2026-05-05',
    changes: [
      { type: 'fixed', text: 'Move button missing on the VmDetail Disks tab. getVmDisks enriches each disk with storageDirId/storageDirName so the UI knows where the file lives, but the underlying virsh lookup didn\'t accept a UUID input — and every public API path passes a UUID. Detect a UUID-shaped input and skip the round-trip.' },
      { type: 'fixed', text: 'Move-to-wrong-purpose returned HTTP 500 instead of 4xx. Templates and ISOs move endpoints now map ValidationError to 400 and "not flagged for {purpose}" / "already exists" errors to 409.' },
      { type: 'fixed', text: '/tmp and /var/tmp were not in the forbidden list when registering a storage directory. /tmp is cleared on reboot, silently destroying VM disks on next boot. Both now rejected up-front.' },
      { type: 'fixed', text: 'Relative path registration ("templates" or similar) was rejected with "cannot be inside the VirtPilot install directory" because path.resolve runs the input through process.cwd(). Now rejected up-front with "must be absolute".' },
    ],
  },
  {
    version: '2.3.0',
    date: '2026-05-05',
    changes: [
      { type: 'added', text: 'Move templates, ISOs, and VM disks between storage directories. Each row in the Templates list, ISOs list, and the Storage page\'s VM Disks table gets a "Move to another storage directory" button alongside Delete. Moves are physical file moves on disk (cross-filesystem aware — falls back to copy + unlink when source and destination are on different mounts). VM disks additionally get their domain XML rewritten so libvirt knows the new path; the VM must be stopped before its disk can be moved. Templates with VMs created from them are blocked from moving (the qcow2 backing chain encodes the absolute path at create time, so moving would silently break those VMs at next start). ISOs currently attached as a CDROM to any VM are blocked for the same reason.' },
      { type: 'added', text: 'Missing-file detection for VM disks. The VM detail page surfaces an amber "missing" badge on any disk whose source path no longer exists on the host (mount disappeared, file deleted out from under VirtPilot, manual mv outside the dashboard). Each disk row also shows which storage directory holds the file. Detection runs on every VM info refresh.' },
    ],
  },
  {
    version: '2.2.0',
    date: '2026-05-05',
    changes: [
      { type: 'added', text: 'Multiple storage directories. Templates, ISOs, and VM disks no longer have to live under /var/lib/virtpilot. Mount any local disk, NFS share, or iSCSI volume to a folder, register it on the redesigned Storage page, and pick it when uploading a template, downloading an ISO, creating a VM, or adding an extra disk. Each registered directory is purpose-tagged (templates / ISOs / VM disks — any combination), shows free/used space with a health indicator, and one directory per purpose can be flagged as the default for new uploads. The original /var/lib/virtpilot layout is auto-seeded on first boot as the "Local" directory with all three purposes set as default, so existing flows keep working untouched. Per-VM control state (NVRAM, name.txt, cloud-init seed) stays on the system root so libvirt can still start a VM if a non-default mount drops; only the qcow2 disk files migrate to the chosen directory.' },
    ],
  },
  {
    version: '2.1.0',
    date: '2026-05-04',
    changes: [
      { type: 'added', text: 'Download a VM\'s disk image. New download buttons on the VM detail "Disks" tab and on the Storage page next to each qcow2 file. Clicking either streams the disk straight from the host to the browser — no temp file, no double disk usage — so disks of any size go through without buffering. The VM must be stopped (or undefined / orphaned) before its disk can be downloaded; otherwise the file is being mutated live and the download would be torn. The button is disabled with a tooltip when the VM is running. Auth uses a single-shot, 60-second signed ticket bound to that one filename rather than the regular Bearer token, so it can ride in the URL without exposing the long-lived session. Useful for moving VMs between VirtPilot installations: download the disk on the source host, upload it back as a template on the destination.' },
    ],
  },
  {
    version: '2.0.5',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'Snapshot revert and snapshot-export-to-template still failed after v2.0.4, this time on the *write* side. `qemu-img create -b sealed overlay` couldn\'t create the revert overlay inside `vms/<uuid>/` (the dir was 0755 owned virtpilot:virtpilot — group can read+traverse but not write), and `qemu-img convert ... templates/<dest>.qcow2` couldn\'t write into the templates dir for the same reason. v2.0.5 bumps the storage subdirs to mode 0770 in `ensureDirs()` (templates, isos, vms, cloud-init, backups) so libvirt-qemu — a member of the virtpilot group via v1.21.6\'s group plumbing — can write into them. Per-VM dirs are also chmodded to 0770 in `createVmDisk` / `createBlankPrimaryDisk` / `createBlankDisk`. The parent `/var/lib/virtpilot` stays at 0750 from install.sh — the group can still traverse to find subdirs but can\'t see siblings.' },
    ],
  },
  {
    version: '2.0.4',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'Snapshot delete (stopped path) and disk resize on a post-snapshot active disk still failed after v2.0.3. v2.0.3 routed VM-disk qemu-img calls via `sudo -u libvirt-qemu`, but external snapshot overlays emerge from `virsh snapshot-create-as` owned `virtpilot:virtpilot` mode 0600 — meaning libvirt-qemu (a member of the virtpilot group, but not the owner) could neither read nor write them. The qemu-img-as-libvirt-qemu invocations therefore EACCESed on the overlay even though the helper itself was correct. v2.0.4 adds a chmod 0660 in three places: (1) right after `virsh snapshot-create-as` succeeds, on every newly-created overlay path; (2) defensively at the start of each `deleteSnapshot` iteration in case libvirt has re-chowned in the interim; (3) in `resizeDisk` before invoking `qemu-img resize`, since the active disk may itself be a snapshot overlay. With the file mode at 0660 the virtpilot group (which includes libvirt-qemu per v1.21.6\'s group plumbing) gets read+write, and the qcow2-chain operations all succeed under either user.' },
    ],
  },
  {
    version: '2.0.3',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'Snapshot delete (and other qcow2-touching operations on started VMs) failed with `qemu-img: Could not open …: Permission denied`. Once a VM has run, libvirt\'s `dynamic_ownership=1` chowns the active qcow2 to `libvirt-qemu:kvm` mode 0644 and the snapshot overlay to mode 0600. The unprivileged backend user (`virtpilot`) can read mode-0644 group-readable files but cannot write them, and cannot read mode-0600 files at all — so any `qemu-img commit`, `qemu-img info` on the overlay, `qemu-img resize`, or `qemu-img convert` (snapshot-export-to-template) hit EACCES. v1.21.9 solved the same shape on the backup path by running `qemu-img convert` via `sudo -u libvirt-qemu`. v2.0.3 generalises that fix into a `qemuImg()` helper in `safeExec.ts` and routes every VM-disk-touching qemu-img call through it: snapshot delete (running + stopped paths), snapshot revert, snapshot-export-to-template (both external and live paths), disk resize, getSnapshotSizeBytes, and the to-template flow\'s backing-chain probe. The existing `virtpilot ALL=(libvirt-qemu) NOPASSWD: /usr/bin/qemu-img` sudoers rule covers all of them. `qemu-img create` calls in `storageService` are unchanged — they write fresh files in already-virtpilot-owned directories. Pre-existing in v1.x — unrelated to the v2.0.0 UUID refactor — but fixed alongside the release.' },
    ],
  },
  {
    version: '2.0.2',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'VM delete now tears down its iptables firewall chains and FORWARD jump rules. Previously, `firewallService.deleteFirewallConfig` only unlinked the per-VM `*-firewall.json` config; the `VP-IN-${uuid8}` / `VP-OUT-${uuid8}` chains and the FORWARD jump rules pivoting on the VM\'s IP persisted. If the same IP later got allocated to a different VM, the orphaned rules would still match traffic to/from that IP. The delete handler now snapshots the VM\'s primary IP before undefine (from `vmMeta.networks[].ip` or live ARP) and calls `removeVmFirewall(uuid, ip)` to flush + drop the chains and remove the FORWARD jumps. Pre-existing in v1.x — unrelated to the v2.0.0 UUID refactor — but easy to fix while we were here.' },
    ],
  },
  {
    version: '2.0.1',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'Rename failed with `domain \'X\' is already defined with uuid Y`. The v2.0.0 rename flow assumed `virsh define` on an existing `<uuid>` would update the domain\'s `<name>` element in place. It does not — libvirt rejects the redefine because the existing entry has a different name. Restored the v1-era `undefine --keep-nvram --snapshots-metadata` + `define` cycle: NVRAM (UUID-keyed) survives the cycle untouched, snapshot metadata is preserved, and the domain comes back under the new name with the same UUID. BIOS-firmware VMs that reject `--keep-nvram` fall back to a plain `undefine --snapshots-metadata`.' },
    ],
  },
  {
    version: '2.0.0',
    date: '2026-05-04',
    changes: [
      { type: 'changed', text: 'Storage paths are now keyed on a per-VM UUID instead of the user-typed name. Every VM gets a `crypto.randomUUID()` at create time, injected into the libvirt domain XML\'s `<uuid>` element, and used as the storage identity across the whole system: `${vmsDir}/${uuid}/`, `${cloudInitDir}/${uuid}/`, NVRAM `${uuid}-nvram.fd`, cloud-init seed `${uuid}-seed.iso`, domain XML stash `${uuid}-domain.xml`, firewall iptables chains `VP-IN-${uuid8}` / `VP-OUT-${uuid8}` (uuid8 = first 8 hex chars), `vm_metrics.vm_uuid` SQLite column, IP allocations, DHCP reservations, port-forwards, and backup directories `${backupRoot}/${uuid}/`. The libvirt domain `<name>` element stays the user-typed friendly label and is mutable via rename; the UUID is the immutable identity. Cloud-init `instance-id` now uses the UUID too, so cloud-init never re-runs user-data when the operator renames a VM. **Breaking change**: API routes `/api/vms/:name` → `/api/vms/:uuid`, backup routes `/api/backups/:vmName` → `/api/backups/:vmUuid`, WebSocket query param `?vm=<name>` → `?vm=<uuid>`. Frontend routes `/vms/:name` → `/vms/:uuid`.' },
      { type: 'fixed', text: 'The 409 "Storage directory for X already exists. Remove manually before retrying." error is gone. Recreating a VM with the same friendly name as a previously deleted one used to collide with leftover storage; it now lands in a fresh UUID-keyed directory and never collides.' },
      { type: 'fixed', text: 'Rename collapses to a single `virsh define`. The previous flow had to `undefine --keep-nvram` then redefine, plus rekey firewall chains, port-forwards, IP allocations, and SQLite metrics rows by name. With UUID-keyed storage, the libvirt domain (identified by its stable `<uuid>`) is updated in place with the new `<name>` element, the on-disk `name.txt` marker is rewritten, and the `vmMeta` record\'s `name` field is updated. Nothing else moves.' },
      { type: 'added', text: '`name.txt` marker inside each `${vmsDir}/${uuid}/` records the VM\'s current friendly name for operators sshing into the host. `ls $vmsDir` shows UUIDs; `cat $uuid/name.txt` maps each one back to its label without going through libvirt or the dashboard.' },
      { type: 'added', text: '`subjectUuid` field on log entries lets the Logs page group VM-scoped events across renames. The `subject` field continues to be the friendly name at write time, so the log line stays human-readable; `subjectUuid` carries the immutable identity.' },
    ],
  },
  {
    version: '1.22.0',
    date: '2026-05-04',
    changes: [
      { type: 'changed', text: '`install.sh` no longer prompts for nginx — it is always installed. The reverse proxy is the only sensible default (TLS termination, request streaming, large-upload handling, single public surface), and the prompt was a foot-gun: skipping it left the Node backend bound to `0.0.0.0:3001` directly, with no separation between TLS termination and application code. The `VP_NGINX=` env var, the TTY question, and the `USE_NGINX` branches in the closing summary are gone. Existing installs are unaffected — `update.sh` doesn\'t run install.sh — but every fresh install now lands on the nginx-fronted topology that v1.21.0 introduced.' },
      { type: 'added', text: 'Default NAT network "myNet" is seeded on fresh install. Before today, a freshly installed dashboard had zero networks and the operator had to visit the Networks page and create one before any VM could get a NIC. `install.sh` now defines a libvirt NAT network (bridge `vp0`, CIDR `10.0.1.0/24`, gateway `10.0.1.1`, DHCP `10.0.1.2–10.0.1.254`, DNS `1.1.1.1` + `8.8.8.8`) and appends a matching entry to `/var/lib/virtpilot/networks.json` so the dashboard surfaces it immediately. The seed step is idempotent — re-running `install.sh` on an install that already has a `myNet` entry leaves it in place — and only fires on fresh installs (`update.sh` never runs install.sh).' },
    ],
  },
  {
    version: '1.21.11',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: '`sudo: unable to change to root gid: Operation not permitted` survived both v1.21.8 and v1.21.10. v1.21.8 removed the explicit `NoNewPrivileges=true` from the unit; v1.21.10 dropped `CapabilityBoundingSet=`. Both fixes were aimed at the right symptom but missed the actual switch: per `systemd.exec(5)`, `RestrictSUIDSGID=true` *"implies `NoNewPrivileges=yes`, ignoring the value of [the explicit `NoNewPrivileges`] setting"*. So the kernel `no_new_privs` bit was still being set on every service start by the `RestrictSUIDSGID` line in the unit, the `setuid` bit on `/usr/bin/sudo` therefore did nothing, and sudo aborted in its init phase before it ever reached `qemu-img` — same error message regardless of which intermediate hardening line was removed. The v1.21.8 release shipped without ever exercising the in-app self-upgrade flow (which goes through `sudo systemd-run`); manual `sudo bash update.sh` from SSH masked the regression because that path is already root and never invokes setuid sudo. `RestrictSUIDSGID` is now omitted from the unit and stripped from any pre-existing live unit by `update.sh`. The protection it nominally offered was illusory in this service: it blocks *creating* setuid files, not *exec\'ing* them, and the backend has no reason to `chmod +s` anything. Real isolation continues to come from `ProtectSystem=strict` + `ProtectKernel*` + `ReadWritePaths=/var/lib/virtpilot`.' },
    ],
  },
  {
    version: '1.21.10',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'The v1.21.9 backup fix died inside sudo with `unable to change to root gid: Operation not permitted` and `error initializing audit plugin sudoers_audit`. v1.21.0 pinned `CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW` on `virtpilot.service`. The bounding set persists across `execve`, so when the setuid-root sudo binary takes over it lacks `CAP_SETUID`, `CAP_SETGID` and `CAP_AUDIT_WRITE` — sudo\'s first `setgid(0)` and the audit plugin\'s `auditctl` calls both `EPERM` out, and the entire invocation aborts before it ever reaches `qemu-img`. Same root cause would silently break `sudo systemd-run` (in-app self-upgrade) and `sudo apt-get` (apt upgrade flow); v1.21.8 only removed `NoNewPrivileges`, not the bounding set, so those paths were one user-test away from the same wall. The bounding set now drops back to the systemd default — `ProtectSystem=strict` + `ProtectKernel*` + `ReadWritePaths` are still in force for the real isolation, and the blast-radius argument for pinning the bounding set is illusory anyway since the service already has sudo rights to apt-get/systemctl per `/etc/sudoers.d/virtpilot`. `update.sh` strips `CapabilityBoundingSet=` from any pre-existing live unit and runs `daemon-reload` before restart, so a one-time `sudo bash /usr/local/virtpilot/update.sh` heals an already-stuck install.' },
    ],
  },
  {
    version: '1.21.9',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'Backups failed with `qemu-img: Could not open … Permission denied` for any VM that had ever been started. v1.21.0 moved the backend off root onto the unprivileged `virtpilot` system user. While a VM is running (or was running and libvirt has not yet restored the original ownership), libvirt\'s `dynamic_ownership=1` chowns the qcow2 to `libvirt-qemu` mode 0600 — so the backend\'s own `qemu-img convert` call ran straight into EACCES. The v1.21.6 fix made libvirt-qemu a member of the `virtpilot` group, which solved the *forward* direction (libvirt-qemu traversing into virtpilot\'s storage tree); the reverse — virtpilot reading a libvirt-qemu-owned file — is not solvable by group membership when the file is mode 0600. `backupService` now invokes `qemu-img convert` via `sudo -n -u libvirt-qemu /usr/bin/qemu-img …`, gated by a tightly-scoped sudoers rule (`virtpilot ALL=(libvirt-qemu) NOPASSWD: /usr/bin/qemu-img`). The destination directory is bumped from 0755 to 0770 so libvirt-qemu (already in the `virtpilot` group) can write the converted qcow2 into the operator\'s backup tree without any further widening. `update.sh` adds the missing sudoers line on existing installs and `visudo`-validates the file before reload. No qemu.conf or libvirtd changes — every other path keeps running unprivileged.' },
    ],
  },
  {
    version: '1.21.8',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'In-app self-upgrade failed with `sudo: The "no new privileges" flag is set, which prevents sudo from running as root`. v1.21.0 added `NoNewPrivileges=true` to `virtpilot.service` for hardening, but the upgrade flow shells out to `sudo systemd-run --unit=virtpilot-update … bash update.sh` (and `apt upgrade` does `sudo apt-get`), and the kernel\'s `no_new_privs` bit makes sudo refuse to elevate even with the NOPASSWD rules in `/etc/sudoers.d/virtpilot`. The hardening was self-defeating: it broke the upgrade path while contributing nothing meaningful, since the iptables/ip-link surface that matters already runs via `CAP_NET_ADMIN` ambient capability rather than sudo. `install.sh` no longer writes the line; `update.sh` strips it from any pre-existing live unit and runs `daemon-reload` before restarting, so a one-time `sudo bash /usr/local/virtpilot/update.sh` from SSH heals an already-stuck install. All other hardening stays in force.' },
    ],
  },
  {
    version: '1.21.7',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'Plaintext guest password no longer ships with every `/api/vms/<name>/meta` poll. The Access card on the VM detail page used to receive the decrypted root password as part of the routine 10-second meta refresh, so the secret sat in the React Query cache, in nginx access logs that include response bodies, and in any browser devtools tab the operator had open. The password now lives behind a separate `/api/vms/<name>/credentials` endpoint that\'s only hit when the operator clicks the eye icon or the copy icon — the standing `/meta` payload no longer carries the secret at all. UI behaviour is unchanged for the operator.' },
      { type: 'fixed', text: 'Backup restore can no longer write disks outside `STORAGE_ROOT/vms/`. `POST /api/backups/<vmName>/<backupId>/restore` accepted a `newVmName` body field that fed straight into `path.join(vmsDir, newVmName)`. A payload like `"../../etc/cron.d/x"` resolved outside `vmsDir` and the restore loop would happily copy the backup\'s qcow2 files into that arbitrary directory (whatever the `virtpilot` service user could touch). The restore handler now runs `validateVmName()` *before* any path math, so a traversal payload is rejected instead of being normalised by `path.join`.' },
      { type: 'fixed', text: 'Backup routes reject malformed `:backupId` URL params. `GET`, `DELETE`, and `POST .../restore` all accepted any string as the backup id and passed it straight through `path.join(backupRoot, vmName, id)`. URL-encoded `..%2F` traversal worked because Express doesn\'t strip `..` from path params. All three endpoints now gate on the strict `^\\d{8}T\\d{6}Z-[0-9a-f]{6}$` shape that `backupId()` actually produces, so the `path.join` only ever sees a known-good leaf id.' },
      { type: 'changed', text: 'WebSocket auth no longer accepts the legacy `?token=<jwt>` query param. v1.21.0 moved console/SSH/VNC tokens to `Sec-WebSocket-Protocol: virtpilot.token.<jwt>` to keep them out of nginx logs, journalctl, and browser history, but the server kept honouring the old query-string form during the upgrade window. The fallback is gone — the dashboard already uses the header form, so anyone on a build older than v1.21.0 just needs to refresh.' },
    ],
  },
  {
    version: '1.21.6',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'Clean install couldn\'t start any VM — `Cannot access storage file ... (as uid:64055, gid:994): Permission denied`. `install.sh` chowned `/var/lib/virtpilot` to `virtpilot:virtpilot` mode 750, but QEMU runs as `libvirt-qemu` and that user wasn\'t in the `virtpilot` group, so it couldn\'t even traverse the storage tree to reach `vms/<name>/disk.qcow2`. libvirt\'s `dynamic_ownership` would have handled the disk file\'s own permissions, but path traversal failed first. The installer now adds `libvirt-qemu` to the `virtpilot` group and restarts `libvirtd` so the daemon picks up the new supplementary group before forking qemu. Existing installs: re-run `install.sh` (idempotent) or do `sudo usermod -aG virtpilot libvirt-qemu && sudo systemctl restart libvirtd` once.' },
    ],
  },
  {
    version: '1.21.5',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'The v1.21.4 CORS fix didn\'t work behind nginx. I checked `URL.host === req.headers.host` for same-origin, but nginx\'s `proxy_set_header Host $host` *strips the port* — so the backend saw `Host: 89.167.48.215` while the Origin URL still said `89.167.48.215:3001`. They never matched and the cors callback errored on every same-origin asset request, producing the same 500 + `text/html` symptoms as v1.21.3. CORS now compares hostnames only (`URL.hostname` against `req.headers.host` with the port stripped), which is correct regardless of whether the request arrives directly or via nginx. Also patched the bundled nginx vhost to use `$http_host` instead of `$host` so the backend sees the original `Host` header verbatim' },
    ],
  },
  {
    version: '1.21.4',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: 'White page after a fresh v1.21 install — the JS bundle returned 500 and the CSS came back as `text/html`. Two interacting bugs in the v1.21.0 hardening: (1) the new CORS middleware accepted requests only when `Origin` was on the `ALLOWED_ORIGINS` allow-list, but Vite\'s `<script crossorigin>` tag makes the browser send an `Origin` header even for same-origin module preloads — so the cors callback errored, Express returned 500 to the script request, and the SPA never mounted. The CSS request fell through to the SPA catch-all and came back with `text/html` for the same reason. CORS now treats any request whose `Origin` host matches the request\'s `Host` header as same-origin and allows it unconditionally; cross-origin still gates on `ALLOWED_ORIGINS`. (2) the CSP blocked the Google Fonts stylesheet (`fonts.googleapis.com`) and font files (`fonts.gstatic.com`) — secondary to the white page but cosmetic-broken on its own. CSP now allows both, plus an explicit `style-src-elem`' },
    ],
  },
  {
    version: '1.21.3',
    date: '2026-05-04',
    changes: [
      { type: 'fixed', text: '`bootstrap.sh` and `update.sh` still hit "dubious ownership" on hosts that already had v1.21 installed, even after the v1.21.2 fix. The previous fix wrote `safe.directory` via `git config --global`, but under `curl … | sudo bash` the resolved `$HOME` doesn\'t always end up at `/root` — the config write lands somewhere git won\'t read back from. Both scripts now pass `safe.directory` inline via `git -c safe.directory=…` on every invocation, which is immune to whichever `.gitconfig` HOME ends up resolving to. They also try a best-effort `git config --system --add safe.directory` (writes to `/etc/gitconfig` so future tooling still benefits) but no longer depend on it' },
    ],
  },
  {
    version: '1.21.2',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: '`bootstrap.sh` and `update.sh` failed with "fatal: detected dubious ownership in repository" on any host that had already run the v1.21 installer. The new `install.sh` chowns `/usr/local/virtpilot` to the unprivileged `virtpilot` service user, but bootstrap and update both run git as root, which then refuses to operate on a non-root-owned tree. Both scripts (and `install.sh` itself) now `git config --global --add safe.directory ${INSTALL_DIR}` before any git operation, so the whitelist entry is persisted in root\'s gitconfig and subsequent runs work without manual intervention' },
    ],
  },
  {
    version: '1.21.1',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: '`install.sh` aborted with `BACKEND_PORT: unbound variable` right after hashing the password. The .env heredoc references `${BACKEND_PORT}` and `${PUBLIC_PORT}` in a comment to explain the no-nginx fallback, but those variables were declared in the nginx section *after* the .env was written. Combined with `set -euo pipefail`, this killed the install on the very next step. Both ports are now declared at the top of the script with the other constants so they\'re in scope wherever they\'re referenced' },
    ],
  },
  {
    version: '1.21.0',
    date: '2026-05-03',
    changes: [
      { type: 'changed', text: 'Comprehensive security hardening pass — every Critical and High finding from the public-IP review is addressed. After upgrade you must re-enter your login password (legacy plaintext is migrated to a hash on first login) and existing 2FA secrets are silently re-encrypted on the next settings save' },
      { type: 'changed', text: 'Backend now runs as the unprivileged `virtpilot` system user, not root. `install.sh` creates a dedicated account with `libvirt`/`kvm`/`systemd-journal` group membership and `CAP_NET_ADMIN`/`CAP_NET_RAW` ambient capabilities, sandboxed via `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `ProtectKernelTunables`, `ProtectKernelModules`, `RestrictSUIDSGID`. The handful of operations that still need root go through a tightly-scoped `/etc/sudoers.d/virtpilot` allow-list' },
      { type: 'added', text: 'Login password is hashed with scrypt at install time and verified with `crypto.timingSafeEqual()`. The runtime accepts both `AUTH_PASSWORD_HASH` (preferred) and the legacy plaintext `AUTH_PASSWORD` for backwards compatibility — the first successful login on an upgraded install rewrites `.env` to swap in the hash and remove the plaintext line' },
      { type: 'added', text: 'Brute-force-resistant auth — rate limiter caps `/api/auth/login` and `/api/auth/verify-totp` at 5/10 attempts per 15 minutes per IP, then a 15-minute lockout. TOTP codes are tracked in a replay-protection map so the same code can\'t be submitted twice inside its 90-second tolerance window' },
      { type: 'added', text: 'Logout actually revokes the JWT. Previously a leaked token was usable for the full 24-hour TTL; the new `/api/auth/logout` endpoint adds the bearer token to a server-side revocation list that `requireAuth` and the WebSocket upgrade handler both consult' },
      { type: 'changed', text: 'WebSocket auth moves out of the URL. Console/SSH/VNC endpoints negotiate the JWT via `Sec-WebSocket-Protocol: virtpilot.token.<jwt>` instead of `?token=` — tokens no longer leak into nginx access logs, journalctl, or browser history. SSE endpoints (apt upgrade, virtpilot self-upgrade) similarly switched from `EventSource` to `fetch`+`ReadableStream` so the JWT rides in the `Authorization` header. Each WebSocket gets a `maxPayload` cap so a malicious peer can\'t memory-exhaust the host with one giant frame' },
      { type: 'changed', text: 'Pervasive command-injection elimination. Every shell-out (`virsh`, `iptables`, `ip`, `qemu-img`, `genisoimage`, `apt`, `git`, `systemctl`, `systemd-run`, …) now goes through a single `safeExec.run()` helper using `execFile` with array arguments — no more `exec()` with concatenated strings. A new `lib/validate.ts` gates VM/network/snapshot names, MACs, IPs, CIDRs, ports, port ranges, ICMP types, disk targets, NIC names, bridge names and filenames at every public boundary. Cloud-init `meta-data`/`user-data`/`network-config` are rebuilt with explicit YAML quoting so a hostname with embedded newlines can\'t inject extra cloud-config keys, and SSH key text containing newlines can\'t append `command="…"` lines to `authorized_keys`' },
      { type: 'added', text: 'SSRF guard on URL-driven downloads. The "download ISO/template from URL" endpoints reject anything that isn\'t `http`/`https`, anything resolving to RFC1918/loopback/link-local/CGNAT/IPv6 ULA addresses or to `localhost`/`169.254.169.254`/`::1`, with each redirect target re-validated. Operators on private mirrors can opt out with `ALLOW_PRIVATE_DOWNLOAD=1`' },
      { type: 'fixed', text: 'Path-traversal hardening on uploads, deletes, archives, and backup restore. Multer uploads `path.basename()` `originalname` before joining; tar.gz ISO extractor rejects entries with absolute paths or `..` components (zip-slip); `DELETE` routes re-validate path parameters; `restoreBackup` strips directory components from manifest disk filenames so a tampered backup tarball can\'t write outside the VM directory' },
      { type: 'changed', text: 'CORS now defaults to same-origin only (set `ALLOWED_ORIGINS=https://example.com` for cross-origin frontends) instead of `origin: true, credentials: true`. Helmet\'s CSP is restored with a tight directive set' },
      { type: 'added', text: 'TOTP secrets and VM passwords encrypted at rest. New `lib/secretsCrypto.ts` provides AES-256-GCM with a key derived from the auto-generated `ENCRYPTION_KEY`; legacy plaintext values pass through transparently and are re-encrypted on the next save. `vm-metadata.json` and `user-settings.json` are written with mode 0600' },
      { type: 'added', text: 'Self-upgrade requires TOTP step-up when 2FA is enabled, and is rate-limited to one attempt per 5 minutes. A stolen JWT can no longer push a malicious tag through the in-dashboard self-upgrade path without also stealing the user\'s authenticator code' },
      { type: 'changed', text: 'Default bind address is now `127.0.0.1`, not `0.0.0.0`. Operators put nginx/Caddy in front of port 3001 with a real cert; running directly on a public IP requires explicit opt-in via `BIND_ADDRESS=0.0.0.0` in `.env`. The TLS cert generator stops using `CN=test` — it picks the actual hostname (or, if that\'s empty, the primary IP)' },
      { type: 'changed', text: 'Bootstrap pins to the latest release tag by default. `bootstrap.sh` resolves the latest GitHub release tag and checks that ref out instead of tracking `main`, so a compromise of `main` doesn\'t auto-deploy to every fresh install. Override with `VP_REF=main` or `VP_REF=v1.20.0`' },
      { type: 'changed', text: '`npm ci` instead of `npm install` during install/update — the lockfile is treated as authoritative and refuses to install if `package.json` and `package-lock.json` disagree (defends against tampered npm registry mirrors). `update.sh` now also runs npm as the `virtpilot` user instead of root' },
      { type: 'added', text: 'Optional nginx reverse proxy bundled with `install.sh`. Default-yes prompt offers to install nginx in front of the backend: nginx listens on the existing public port (3001) with the self-signed cert, the Node backend moves to `127.0.0.1:3002` and speaks plain HTTP. Same URL the operator already uses (`https://host:3001`), but TLS termination, request logging, large-file uploads (`client_max_body_size 100G`), WebSocket upgrades for `/ws/*`, and SSE-friendly `proxy_buffering off` all live at the edge instead of in Node. Ports 80 and 443 are intentionally not touched. Skip with `VP_NGINX=no` for unattended installs; if you skip, the backend keeps binding to `0.0.0.0:3001` directly with its own TLS' },
    ],
  },
  {
    version: '1.20.1',
    date: '2026-05-03',
    changes: [
      { type: 'changed', text: 'Installer hard-fails on unsupported architectures and OS versions instead of warning and pressing on. Previously `install.sh` only soft-warned ("This installer targets Ubuntu 24. Proceeding on unrecognised OS...") and there was no architecture check at all, so running on arm64 or Debian/RHEL would proceed past pre-flight and fail later in the Node/build step with an unhelpful error. The check is now strict: `uname -m` must be `x86_64` and `/etc/os-release` must report `ID=ubuntu` and `VERSION_ID=24.04`, otherwise the script dies immediately. Same checks added at the very top of `bootstrap.sh` so the curl-pipe one-liner fails fast before installing git or doing the clone' },
      { type: 'changed', text: 'Removed the duplicate ASCII banner when running via the `curl … | sudo bash` bootstrap. `bootstrap.sh` printed the banner and then exec\'d `install.sh`, which printed the same banner immediately afterwards. The banner now only appears once (from `install.sh`); `bootstrap.sh` keeps a single-line header' },
    ],
  },
  {
    version: '1.20.0',
    date: '2026-05-03',
    changes: [
      { type: 'added', text: 'HTTPS by default with a self-signed TLS certificate. VirtPilot now serves the web UI and all WebSocket traffic (console, SSH, VNC) over TLS instead of plain HTTP. The installer generates a 10-year self-signed certificate at `${STORAGE_ROOT}/tls/{cert,key}.pem` with `subjectAltName` covering the host\'s hostname, `localhost`, the primary IP, and `127.0.0.1`. Existing installs migrate automatically — `update.sh` runs the same idempotent cert generation, so a single update flips an existing host onto HTTPS without manual intervention. The browser will warn about the self-signed cert on first visit; click "Advanced → Proceed" once and the warning is dismissed for that host. Old `http://host:3001` bookmarks need updating to `https://`' },
    ],
  },
  {
    version: '1.19.11',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: '`install.sh` no longer drops out silently at the password prompt when run via the `curl … | sudo bash` bootstrap. The installer used `read -rsp` against stdin, but stdin in that flow is the curl pipe — already EOF by the time the prompt runs. Combined with `set -euo pipefail`, `read` returned non-zero and the script exited immediately after printing "Set a login password for the VirtPilot web UI:" with no further output. The password reads now go to `/dev/tty` directly so the prompt works regardless of how stdin was wired up. Also added a `VP_PASSWORD` env var override for fully unattended installs (`VP_PASSWORD=secret sudo -E bash install.sh`), and a clear error if neither a TTY nor `VP_PASSWORD` is available instead of failing silently' },
    ],
  },
  {
    version: '1.19.10',
    date: '2026-05-03',
    changes: [
      { type: 'changed', text: 'Dashboard\'s Host Metrics section is now collapsible. The four full-width charts (CPU, Memory, Disk I/O, Network) take up a lot of vertical space, which is wasted when you\'ve come to the dashboard for the Overview tiles or to check System Updates. Click the "Host Metrics" header (or its chevron) to fold the whole block away — the Live/1h/24h range toggle is hidden alongside the charts so the collapsed header sits clean. State persists in `localStorage` under `virtpilotHostMetricsCollapsed` so the preference survives reload' },
    ],
  },
  {
    version: '1.19.9',
    date: '2026-05-03',
    changes: [
      { type: 'added', text: 'Storage page now lets you delete orphaned VM folders. When a VM is deleted with "keep storage", or when libvirt loses track of one (e.g. a manual `virsh undefine`), the qcow2 disks under `$STORAGE_ROOT/vms/<name>/` had no UI to remove them — they could only be cleaned by SSHing in and `rm -rf`-ing the directory by hand. The Storage page already flagged these rows with an "orphaned" badge; it now also shows a trash button on those rows (and only those rows). Confirming recursively removes the VM directory and any leftover cloud-init scaffolding (`seed.iso`, `domain.xml`, per-VM cloud-init dir). The endpoint refuses if libvirt still has a domain by that name, so it can\'t wipe storage out from under a defined VM' },
      { type: 'fixed', text: '"Essential cloud images" card now only appears when the templates library is genuinely empty, and re-appears if you later empty it. The card was gated on "any starter image is missing on disk", so a user who\'d uploaded their own qcow2 still saw it whenever they were missing one of the starter set entries. It\'s now gated on `templates.length === 0`. Additionally, the persistent `templateSetDismissed` flag was sticky forever once set — meaning a user who dismissed the card on day 1 would never see it again, even after wiping every template on day 100. The flag now auto-clears whenever the templates list is non-empty, so dismissal effectively means "hide for this empty state" rather than "hide forever"' },
    ],
  },
  {
    version: '1.19.8',
    date: '2026-05-03',
    changes: [
      { type: 'removed', text: 'CentOS Stream 10 dropped from the starter template set. Confirmed on the production host that booting the GenericCloud image under VirtPilot\'s UEFI VMs drops to the EDK II UEFI shell — the qcow2 has only `1.0M BIOS-boot + 7.8G root` (GPT, no EFI System Partition), so OVMF can\'t find a bootloader. The older Stream 9 image and the newer `…-x86_64-…` 10 build ship the same BIOS-only layout; the cloud SIG only publishes BIOS-style images. No URL fix is possible — for a CentOS-equivalent UEFI cloud image use AlmaLinux 9 (already in the set) or AlmaLinux 10. Existing installs that already downloaded `centos-stream-10.qcow2` can delete it from `$STORAGE_ROOT/templates/`; any VMs created from it never reached a kernel and need to be recreated from a working template' },
    ],
  },
  {
    version: '1.19.7',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'Cloud-init now uses `/bin/sh` for the default user so SSH works on Alpine. v1.19.6 fixed Alpine\'s BIOS/UEFI mismatch and the VM booted, but SSH still rejected every attempt with `Permission denied`. The auth log had the real reason: `User virtpilot not allowed because shell /bin/bash does not exist`. The cloud-init template hardcoded `shell: /bin/bash`, which doesn\'t exist on Alpine — sshd refuses login for any user whose shell is missing, regardless of how good the keys or password are. Switched the user shell to `/bin/sh` (the only shell guaranteed everywhere) and added a `runcmd` that does `chsh -s "$(command -v bash)" virtpilot` on systems where bash is installed, so interactive shells on Ubuntu/Debian/RHEL/Alma/Rocky/Fedora/openSUSE still get bash. Only affects newly-created VMs; existing Alpine VMs need their shell updated by hand or to be recreated' },
    ],
  },
  {
    version: '1.19.6',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'Alpine 3.21 starter template now boots. The pinned URL was the BIOS-only artifact (`nocloud_alpine-3.21.0-x86_64-bios-cloudinit-r0.qcow2`), which writes SYSLINUX into the MBR of an unpartitioned ext4 disk — no GPT, no EFI System Partition. VirtPilot defines every VM with `<os firmware=\'efi\'>` (OVMF/UEFI), and OVMF can\'t chain a SYSLINUX MBR, so guests stayed in the firmware boot manager forever — `virsh dominfo` reported `running` while the VM never reached a kernel. Switched the URL to the UEFI variant (`nocloud_alpine-3.21.7-x86_64-uefi-cloudinit-r0.qcow2`, also bumped to the latest 3.21 patch). Existing installs: delete the old `alpine-3.21.qcow2` from `$STORAGE_ROOT/templates/` and re-download (the bulk card resurfaces once it\'s gone). Any VMs already created from the bad template must be recreated, since their `disk.qcow2` overlays the broken backing image' },
    ],
  },
  {
    version: '1.19.5',
    date: '2026-05-03',
    changes: [
      { type: 'added', text: 'QEMU and kernel version are now shown on the dashboard\'s host identity card. The Host zone (under hostname and CPU specs) now lists the QEMU version (parsed from `qemu-system-x86_64 --version`) and the kernel version (`uname -r`) so you can see at a glance which hypervisor/kernel build is in use without dropping to a shell. Both are surfaced via `/api/system/info`; QEMU falls back to `unknown` if `qemu-system-x86_64` isn\'t on PATH' },
    ],
  },
  {
    version: '1.19.4',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'CentOS Stream 10 was silently 403\'ing because the backend sent no User-Agent header — `cloud.centos.org` rejects requests with no UA. Verified by `curl -H "User-Agent:"` from the production host: 403 every time, with default UA: 200 every time. Node\'s `http.get` doesn\'t send a User-Agent by default. Backend now identifies as `VirtPilot/<version>` on every outbound download — fixes CentOS instantly and is good citizenship for mirror operators' },
      { type: 'fixed', text: 'Fedora 41 was 404\'ing because the `download.fedoraproject.org` redirector geo-routes US clients to a mirror that doesn\'t carry Fedora at all (`ftp2.osuosl.org` — OSU OSL\'s real Fedora mirror moved to `fedora.osuosl.org`). The redirector is sticky per client IP, so retries hit the same broken mirror every time (5/5 probes). Most other US mirrors I tested also 404 for Fedora 41 — propagation is still incomplete. Pinned the URL to gemmei.ftp.acc.umu.se (Umeå University, Sweden — long-running academic mirror) to bypass the redirector entirely' },
    ],
  },
  {
    version: '1.19.3',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'Starter template-set now retries transient failures. A v1.19.2 run finished 5 of 9 because 4 mirrors had a brief blip — all 4 URLs returned HTTP 200 from the same host moments later. Each item now gets up to 3 attempts with a 5s backoff before being marked failed; cancelled runs short-circuit retries' },
      { type: 'fixed', text: 'Failure toast is sticky and lists each failed item with its reason (e.g. `Debian 13: HTTP 503`). Previously the toast vanished after 3.5s with no breakdown of what failed or why — easy to miss while on another tab. Backend `job.error` is now surfaced through the polling response into the orchestrator' },
      { type: 'fixed', text: 'Starter card resurfaces whenever any item from the set is missing on disk (and not dismissed) — the orchestrator dedupe-skips already-present files, so retrying a partial run is one click. Previously the card hid as soon as any template existed, leaving no obvious retry path' },
      { type: 'changed', text: 'Backend now logs each template download to stderr (`journalctl -u virtpilot`): `[template-download] start jobId=… file=… url=…` / `done jobId=… bytes=… duration=…s` / `error jobId=… err=…`. Prior-release failures left no trail and were impossible to diagnose without re-running the bulk' },
      { type: 'changed', text: '`streamUrl` enforces an idle-stall timeout (60s after the last byte) and a headers timeout (30s). Previously a mirror that opened a connection then went silent would hang the orchestrator forever — surfaces as `Upstream stalled — no bytes for 60s` / `Upstream did not send headers within 30s` so the per-item retry can take over' },
    ],
  },
  {
    version: '1.19.2',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'Starter template-set bulk download now resumes after a full page reload, tab close, or browser restart. The v1.19.1 fix only survived SPA navigation — the in-memory store was wiped on a hard reload and the run silently halted (live repro: Rocky 9 + AlmaLinux 9 finished, page reloaded, items 3–9 never even POSTed). Fixed by persisting `templateBulk` to localStorage via zustand persist middleware and wiring `resumeTemplateSetDownloadIfNeeded()` into ProtectedRoute so any unfinished run picks back up on the next authenticated mount' },
      { type: 'fixed', text: 'Resume is dedupe-safe. Before resuming, the orchestrator snapshots the current templates list and skips any filename already on disk (counted as succeeded). Avoids re-downloading 600 MB qcow2 files that finished right before the page died but whose state-write was lost' },
      { type: 'fixed', text: 'Single-instance guard prevents the resume firing on ProtectedRoute mount from racing with a fresh "Download starter set" click — second caller is a no-op rather than spawning a parallel loop' },
    ],
  },
  {
    version: '1.19.1',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'Starter template-set bulk download now survives page navigation. Previously the orchestration loop and progress state lived in the TemplatesPage component — clicking "Download starter set" and navigating away caused state writes to vanish into a destroyed setter, the card disappeared on return, and the cancel flag (a useRef) reset on remount. Fixed by mirroring the single-template/single-ISO pattern: bulk state hoisted into uploadProgressStore, orchestration moved to a module-level function in lib/templateSetDownloader.ts. The loop now progresses through all nine images regardless of which page the user is on, and the card re-renders live progress on remount. Side benefit: clicking Download twice is a no-op rather than starting a parallel run' },
    ],
  },
  {
    version: '1.19.0',
    date: '2026-05-03',
    changes: [
      { type: 'added', text: 'Starter template-set card on the Templates page. A fresh install with no templates now sees a one-click "Download starter set" card that pulls nine common amd64 cloud images (Rocky 9, AlmaLinux 9, Ubuntu 24.04, Debian 13, CentOS Stream 10, openSUSE Leap 15.6, Fedora 41, Alpine 3.21, Arch) sequentially in the background. Per-file progress + a "3 of 9" counter + cancel; logos are pre-assigned as each file lands. The card has a dismiss × for users who prefer to manage templates from scratch' },
      { type: 'added', text: 'Card auto-resurrects on empty. Deleting the last template clears the dismissal flag server-side, so wiping everything brings the starter card back without digging into settings' },
      { type: 'added', text: 'Configurable starter set. The list lives in `src/data/templateSets.ts` — edit the array, rebuild, ship. Each entry is `{ url, filename, name, logo }`; all bundled URLs validated against their mirrors before inclusion. Dead links at runtime are skipped per-item rather than aborting the whole set' },
      { type: 'changed', text: '`POST /api/templates/download` now accepts `.qcow2`, `.img`, `.raw`, `.iso`, and `.iso.gz` filenames. Previously anything outside `.qcow2|.img` got `.qcow2` silently appended — affects both the manual "From URL" dialog and the starter-set flow' },
    ],
  },
  {
    version: '1.18.2',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'Cloud-init network-config now applies on RHEL-family guests (AlmaLinux/Rocky/CentOS). Default routes were emitted as `to: default`, which is a netplan shorthand. Debian/Ubuntu cloud-init forwards the config straight to `netplan` (which understands it); RHEL-family cloud-init parses v2 internally and blew up with `ValueError: Address default is not a valid ip address`, aborting the whole network apply. Result: a fresh Alma 10 VM came up with `eth0` link-up but no IPv4 — the host then got `EHOSTUNREACH` when the in-dashboard SSH console tried to reach the configured static IP. Fixed by emitting `to: 0.0.0.0/0` instead' },
      { type: 'fixed', text: 'Cloud-init `ssh_authorized_keys` now actually nests under the user. The keys list was indented at 2 spaces but `ssh_authorized_keys:` lives at 4 spaces inside the `- name:` user dict, so the keys were parsed as sibling list items in `users:` rather than as the user\'s keys. YAML-valid but semantically wrong — cloud-init failed schema validation, no SSH keys were ever installed on any VM, and `lock_passwd: false` was silently dropped along with the rest of the user dict. Existing VMs are unaffected (they won\'t re-run cloud-init) but every VM created after this release gets working key auth' },
    ],
  },
  {
    version: '1.18.1',
    date: '2026-05-03',
    changes: [
      { type: 'changed', text: 'Default cloud-init username is now `virtpilot` (previously `ubuntu`). The VM Create form pre-fills `virtpilot`, so newly-created VMs get an SSH login of `virtpilot@<ip>` by default. The field is still editable on a per-VM basis. Existing VMs are unaffected — their username is persisted in VM metadata and inside the seed.iso, so they keep working as before' },
    ],
  },
  {
    version: '1.18.0',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: '24h metrics charts (host and per-VM) actually bucket. The 5-minute aggregation SQL was `(ts / ?) * ?` with the bucket size bound as a JS Number, which SQLite evaluated as real-number division — so every raw 30-second sample got its own `bucket_ts` and `GROUP BY` was a no-op. Result: ~2880 points per chart instead of ~288, and the 24h range was effectively the same data as 1h until the table accumulated more than an hour\'s worth of rows. Casting to INTEGER inside the division forces the floor we want' },
      { type: 'fixed', text: 'VM delete now cleans up after itself. (1) `?deleteStorage` defaults to `true` so the qcow2 disk dir doesn\'t leak — pass `?deleteStorage=false` to keep it. Previously the default was `false` and recreating a VM with the same name 400-d with a "Storage directory already exists, remove manually" error. (2) Cloud-init artefacts (`{cloudInitDir}/{name}/`, `{name}-seed.iso`, `{name}-domain.xml`) are now removed unconditionally on delete — they\'re internal scaffolding and were never user data, but the previous delete left them behind and they accumulated as zombies for every test VM ever created' },
      { type: 'fixed', text: 'IP allowlist input validation actually validates. Before, `999.999.999.999` was accepted (regex didn\'t enforce 0–255 octets) and any string containing `:` was treated as a valid IPv6 address. Now both forms are checked properly: octet ranges for IPv4, RFC-4291-shaped groups + correct `::` compression handling for IPv6, optional CIDR prefix bounds (0–32 v4, 0–128 v6), and IPv4-mapped forms like `::ffff:1.2.3.4`' },
      { type: 'fixed', text: 'Self-lockout guard on `PUT /api/settings`: if a non-empty `ipWhitelist` is being applied that would exclude the caller\'s own IP, the request 400s with `Refusing to apply allowlist that excludes your own IP (X)` instead of cheerfully writing the file and locking the user out on the next request' },
      { type: 'fixed', text: 'SSH-key add now rejects malformed keys. Previously `publicKey: "this is not a key"` returned 201 OK and the bad key would later silently fail in cloud-init on the guest. New validation gates on the well-known OpenSSH type prefix (`ssh-rsa`, `ssh-ed25519`, `ecdsa-sha2-nistp{256,384,521}`, etc.) and the base64 charset of the blob' },
      { type: 'fixed', text: 'Boot-order PUT now rejects unknown disk targets with a clear `Unknown disk targets in bootOrder: hd, cdrom. Valid targets are: vda, sda, sdb`. Previously sending logical names like `["hd","cdrom"]` 200-d but silently no-op-ed (the underlying XML rewrite only matches `<target dev="...">` entries), so the GET kept returning `[]` after a "successful" PUT' },
      { type: 'fixed', text: 'Snapshot delete after a revert produces an actionable error. The chain-divergence check used to recommend "delete newer snapshots first" even when there were no newer snapshots — only the revert overlay sitting on top. The error now distinguishes that case and points at the new `?metadataOnly=true` escape hatch' },
      { type: 'added', text: '`DELETE /api/vms/{name}/snapshots/{snapshot}?metadataOnly=true` drops just the libvirt snapshot record without merging the overlay back into its backing — the escape hatch for VMs whose chain has diverged from the snapshot' },
      { type: 'added', text: '`POST /api/vms/{name}/{stop,reboot}` now accepts `force` from either the JSON body (`{"force": true}`) or the query string (`?force=true`). Previously only the query string worked and bodies were silently ignored' },
      { type: 'added', text: 'Backup summaries now expose `vmExists` so the UI can mark orphan rows for VMs that have been deleted but whose backup metadata remains' },
    ],
  },
  {
    version: '1.17.2',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: '`update.sh` build failure: `siProxmox` declared but its value is never read. The v1.16.0 OS-logo expansion imported `siProxmox` from `simple-icons` with the intention of including Proxmox in the appliance category, but the entry never made it into the `SPECS` array. The frontend\'s `npm run build` runs `tsc -b` which respects `noUnusedLocals: true` from `tsconfig.app.json`, so the build aborted. Proxmox is now included as originally intended' },
      { type: 'added', text: 'Proxmox (`siProxmox`) restored to the OS-logo picker under the Appliances section' },
    ],
  },
  {
    version: '1.17.1',
    date: '2026-05-03',
    changes: [
      { type: 'fixed', text: 'Self-update modal no longer hangs on "Restarting service…". The polling loop that waits for the new backend to come back up listed `invalidateVersion` (returned by `useInvalidateVersion()`) in its `useEffect` deps. The hook returned a fresh function reference on every render, so every 2 s — when the dashboard re-rendered because of `useSystemStats` polling — the effect re-ran: the previous polling tick was cancelled mid-flight, and the 90 s timeout deadline was reset. Two fixes applied: `useInvalidateVersion` and `useInvalidateApt` are now wrapped in `useCallback` so they return stable refs across renders, and the redundant `invalidateVersion()` call right before `window.location.reload()` was removed — the reload throws away the cache anyway. Existing stuck modals can be unstuck by reloading the page; the new backend was already running' },
    ],
  },
  {
    version: '1.17.0',
    date: '2026-05-03',
    changes: [
      { type: 'changed', text: 'Dashboard "Live Metrics" section restyled to match the per-VM Metrics tab. Renamed to "Host Metrics" and given a Live / 1h / 24h range selector in the section header. The 2×2 grid of cards (each with a sparkline area chart) is replaced by a single column of full-width cards stacked one per row — CPU Usage, Memory, Disk I/O, Network. Each chart now uses the same `MetricChart` component as the per-VM tab: labelled Y axis (5 ticks: 0/25/50/75/100 % for CPU and Memory; auto-scaled byte values for Disk and Network), labelled X axis with timestamps, dashed horizontal grid lines, and a "nice" round Y-max so small spikes don\'t flatten the baseline. Card chrome (coloured top stripe, glowing icon badge, accent typography) is preserved' },
      { type: 'added', text: 'Persistent host metrics storage. A new SQLite table `system_metrics` (migration v2) records one host sample every 30 s with CPU %, memory, disk and network throughput. 24-hour retention. Persistence is wired into the existing 2-second `statsService.takeSample()` and gated by a 30 s minimum interval, so no new sampler runs. New `GET /api/system/metrics?range=1h|24h` endpoint returns 30 s points for `1h` and 5-minute aggregated buckets for `24h`' },
      { type: 'removed', text: 'Internal: deleted the `AreaChart` component. It was only used by the dashboard\'s old chart-bearing card; everything now goes through the per-VM `MetricChart`' },
    ],
  },
  {
    version: '1.16.0',
    date: '2026-05-03',
    changes: [
      { type: 'added', text: 'Bigger OS-logo selection on the Templates and ISOs pages — 17 entries grew to 43, organised into Linux / BSD / Privacy & Security / Appliances / Other sections. New Linux distros: Red Hat, SUSE, Pop!_OS, elementary OS, Zorin, Artix, EndeavourOS, Garuda, Void, Deepin, Solus, generic Tux. New BSDs: OpenBSD, NetBSD. Privacy: Qubes OS, Tails. Turnkey appliances commonly run as KVM guests: pfSense, OPNsense, OpenWrt, MikroTik, TrueNAS, openmediavault, Home Assistant, Pi-hole, AdGuard, Talos. All icons ship in the existing `simple-icons` dependency, no new packages' },
      { type: 'added', text: 'Search box and category headings in the OS-logo picker. The dropdown opens with a focused search input at the top, groups results under section headings, and the body scrolls when there are more entries than fit. Empty-state placeholder when no logos match the query' },
      { type: 'changed', text: 'Logos with very dark brand colours (pfSense, MikroTik, SUSE, …) now render readably in both light and dark themes. Tiles for those logos use a foreground-tinted background and render the icon in the foreground colour instead of vanishing against the brand-tinted tile. Bright brand colours unchanged' },
    ],
  },
  {
    version: '1.15.2',
    date: '2026-05-02',
    changes: [
      { type: 'fixed', text: 'Defence-in-depth for the self-update lockfile-drift abort fixed in v1.15.1. The backend\'s `/api/system/upgrade` handler now also discards `package-lock.json` drift before spawning `update.sh`, so the orchestrator ensures the precondition even if a future `update.sh` ever loses its own cleanup. No effect on installs already running cleanly' },
    ],
  },
  {
    version: '1.15.1',
    date: '2026-05-02',
    changes: [
      { type: 'fixed', text: 'Self-update no longer aborts when `package-lock.json` has been mutated by a previous `npm install` on the host. The first `npm install` after a fresh checkout regenerates the lockfile with host-specific binary entries (e.g. linux-x64) that aren\'t in the macOS-generated lockfile committed upstream — leaving the working tree dirty and causing the next `git pull --ff-only` to abort. `update.sh` now discards lockfile drift before pulling. Existing stuck installs need a one-time manual unblock: `git checkout -- package-lock.json && bash update.sh` in the install directory' },
    ],
  },
  {
    version: '1.15.0',
    date: '2026-05-02',
    changes: [
      { type: 'changed', text: 'Per-VM metric charts redesigned for clarity. The four charts on the VM Metrics tab (CPU, Memory, Disk I/O, Network I/O) now stack one per row instead of a 2×2 grid, giving each chart the full content width. Each chart gained a labelled Y axis (0/25/50/75/100 % for CPU and Memory; auto-scaled byte values for Disk and Network), a labelled X axis with timestamps, and dashed horizontal grid lines. Plot height grew from 72 px to 200 px. Disk and Network charts auto-scale to a "nice" round maximum so small spikes no longer flatten the baseline' },
    ],
  },
  {
    version: '1.14.0',
    date: '2026-05-02',
    changes: [
      { type: 'added', text: 'ISO uploads and URL downloads now accept compressed `.iso.gz` and `.iso.tar.gz` files (also `.gz` and `.tgz`). The server detects the format via gzip magic bytes plus the file extension, decompresses streamingly, and writes a plain `.iso` to the storage directory — no need to gunzip locally before uploading a pfSense or similar release. For tar.gz archives the first `.iso` entry is extracted (others are ignored). The ISOs page subtitle, empty state, upload dialog and URL download dialog all explain the supported formats. URL downloads now show a "Decompressing" status while the post-download decompression runs' },
    ],
  },
  {
    version: '1.13.9',
    date: '2026-05-02',
    changes: [
      { type: 'fixed', text: 'ISO/Template URL downloads no longer appear in the listing while still being downloaded. The server now streams to a `.part` file and atomically renames on completion, and the early invalidate that flashed the half-written file into the table on download start is gone' },
      { type: 'added', text: 'Cancel button on the URL download progress card for both ISOs and Templates. The X stops the in-flight HTTP request, removes the partial `.part` file, and shows a "Download cancelled" toast' },
      { type: 'fixed', text: 'Cancelled ISO/Template uploads no longer leave 32-hex multer temp files behind in the storage directory. Both upload routes now clean up `req.file.path` on connection abort or any error path. (One existing slc-gateway install had ~40 GB of these orphans accumulated.)' },
    ],
  },
  {
    version: '1.13.8',
    date: '2026-05-02',
    changes: [
      { type: 'added', text: '"Check now" button on the VirtPilot version card. Bypasses the backend\'s 10-minute GitHub release cache so a freshly published release shows up immediately instead of waiting for the next 5-minute polling tick. Available in all three states of the card (up to date, update available, in-app upgrade unavailable)' },
    ],
  },
  {
    version: '1.13.7',
    date: '2026-05-02',
    changes: [
      { type: 'changed', text: 'Redesigned every tile on the Dashboard around the visual language of the "Update available" card — Host identity, the four stat tiles (VMs, Disk, Memory, System Updates), and the four Live Metrics cards (CPU, Memory, Disk I/O, Network) all now share rounded-2xl shells with layered radial gradients, blurred colour orbs, a coloured top accent stripe, a glowing icon badge with gradient fill and ring, and accent-coloured labels and big values. One palette config drives every tile so colours stay perfectly consistent' },
    ],
  },
  {
    version: '1.13.6',
    date: '2026-05-02',
    changes: [
      { type: 'fixed', text: 'Login page no longer says "Invalid password" when the real reason is the IP allowlist. Backend now returns a distinct 403 with the client\'s IP, and the login form shows "Access denied — your IP address X.X.X.X is not on the allowlist. Contact your administrator." Same handling on the TOTP step' },
    ],
  },
  {
    version: '1.13.5',
    date: '2026-05-02',
    changes: [
      { type: 'fixed', text: 'Improved readability of the VirtPilot version cards — dropped the gradient-clipped text on version numbers (low contrast against tinted backgrounds), now using solid theme-aware colours. Old version is struck through. Background gradient opacities cut by ~40% so text wins. Small uppercase labels brightened with explicit dark-mode variants' },
    ],
  },
  {
    version: '1.13.4',
    date: '2026-05-02',
    changes: [
      { type: 'changed', text: 'Up-to-date variant of the VirtPilot version card now matches the visual weight of the Update-available variant — same rounded card with layered radial gradients, same glowing icon badge, same big monospace version display with gradient-clipped text. Just emerald instead of blue/violet, and a "View latest release" link instead of an Update CTA' },
    ],
  },
  {
    version: '1.13.3',
    date: '2026-05-02',
    changes: [
      { type: 'changed', text: 'Moved the VirtPilot version card out of the Overview section into its own labelled "VirtPilot" section on the Dashboard, matching the structure of the other sections' },
    ],
  },
  {
    version: '1.13.2',
    date: '2026-05-02',
    changes: [
      { type: 'changed', text: 'Redesigned the "Update available" card on the Dashboard — bigger, layered blue-to-violet gradient background, large monospace version transition with gradient text on the new version, glowing sparkle badge, and a custom gradient "Update now" button with hover shimmer. The inline release-notes preview is gone in favour of a single "View release notes" link to the GitHub release page' },
    ],
  },
  {
    version: '1.13.1',
    date: '2026-05-02',
    changes: [
      { type: 'changed', text: 'VirtPilot version card on the Dashboard is now always visible — when up to date it shows a compact green strip with the current version and a link to the latest release. Previously it was hidden entirely until an update was available, which made it look like the feature wasn\'t there' },
    ],
  },
  {
    version: '1.13.0',
    date: '2026-05-01',
    changes: [
      { type: 'added', text: 'In-dashboard self-upgrade — a new card under Overview on the Dashboard surfaces when a newer VirtPilot version is published on GitHub Releases. One click runs update.sh inside a transient systemd unit, streams live build output into a terminal modal, and reloads when the new version is up' },
      { type: 'added', text: 'bootstrap.sh one-liner installer — `curl -fsSL https://raw.githubusercontent.com/ptmplop/virtPilot/main/bootstrap.sh | sudo bash` clones to /usr/local/virtpilot and runs the installer' },
      { type: 'changed', text: 'install.sh now requires a git clone (in-app upgrades depend on it) and writes VIRTPILOT_REPO_DIR into .env so the backend has an explicit repo path' },
      { type: 'fixed', text: 'Backend VERSION constant is now read from package.json at startup instead of being hardcoded — backup metadata had been stamping every backup as v1.7.0 since the constant was last manually updated' },
    ],
  },
  {
    version: '1.12.1',
    date: '2026-05-01',
    changes: [
      { type: 'changed', text: 'Friendlier labels in the Snapshots tab "VM State" column — `disk-snapshot` → Disk only, `running` → Live (with RAM), `shutoff` → Offline. The column describes what the snapshot captured, not the VM\'s live state' },
    ],
  },
  {
    version: '1.12.0',
    date: '2026-05-01',
    changes: [
      { type: 'added', text: 'Snapshot size column on the VM Snapshots tab — see the on-disk cost of each snapshot alongside Created and VM State. External snapshots sum their overlay files; internal snapshots report saved RAM (vm-state-size) from qemu-img info' },
    ],
  },
  {
    version: '1.11.0',
    date: '2026-05-01',
    changes: [
      { type: 'added', text: 'Per-VM metrics history — the VM detail Metrics tab now has a Live / 1h / 24h range selector backed by a SQLite ring buffer, so CPU, memory, disk and network charts survive restarts and reach back beyond the last 30 seconds' },
      { type: 'added', text: 'Background sampler writes a metrics row every 30s for every running VM; 24h range aggregates into 5-minute buckets via SQL AVG so the chart stays readable. Rows are pruned after 24 hours' },
      { type: 'added', text: 'New embedded SQLite layer (`$STORAGE_ROOT/virtpilot.db`) for state libvirt doesn’t track itself — schema, migrations, and per-VM cleanup hooks documented in DATABASE.md so future features can reuse it' },
    ],
  },
  {
    version: '1.10.0',
    date: '2026-05-01',
    changes: [
      { type: 'added', text: 'Per-NIC bandwidth shaping — set inbound and outbound rate limits in MB/s on each network interface; values apply live (no shutdown needed) via libvirt’s tc-based shaper and persist across reboots' },
      { type: 'added', text: 'Rate Limit column on the VM Network tab shows the current cap per NIC; pencil/gauge button opens an inline editor; the same fields are available when adding a new NIC' },
    ],
  },
  {
    version: '1.9.3',
    date: '2026-05-01',
    changes: [
      { type: 'changed', text: 'Templates created from a snapshot now inherit the logo from the VM’s original template by reading the recorded metadata, instead of probing the qcow2 backing chain (which broke once external snapshot overlays sat between the active disk and the template)' },
    ],
  },
  {
    version: '1.9.2',
    date: '2026-05-01',
    changes: [
      { type: 'fixed', text: 'Deleting a snapshot on a running VM cloned from a shared template no longer fails with "Failed to get write lock" — blockcommit was walking the whole backing chain down to the template; now pinned to the overlay → immediate backing only' },
    ],
  },
  {
    version: '1.9.1',
    date: '2026-05-01',
    changes: [
      { type: 'fixed', text: 'Cancel button (X) on ISO and template upload progress bars now actually aborts the upload — the abort callback was being stored as a thunk that returned the abort function instead of calling it' },
    ],
  },
  {
    version: '1.9.0',
    date: '2026-05-01',
    changes: [
      { type: 'added', text: 'Snapshots now work on UEFI VMs — switches automatically to external --disk-only snapshots (per-disk qcow2 overlay) when QEMU cannot store internal snapshots alongside pflash firmware' },
      { type: 'added', text: 'External snapshot revert restores the saved domain XML and caps the sealed disk with a fresh overlay, so reverting to the same snapshot multiple times still works' },
      { type: 'added', text: 'External snapshot delete merges the overlay back into its backing via blockcommit --active --pivot (running) or qemu-img commit (offline)' },
      { type: 'fixed', text: 'No more "internal snapshots of a VM with pflash based firmware are not supported" error on modern UEFI guests' },
    ],
  },
  {
    version: '1.8.5',
    date: '2026-05-01',
    changes: [
      { type: 'changed', text: 'Dashboard: coloured top accent stripe on each MetricCard matching its chart colour, with coloured hover glow per card' },
      { type: 'changed', text: 'Dashboard: StatTile expanded with blue/violet accent types; VM tile uses blue; running VM dots now pulse' },
      { type: 'changed', text: 'Dashboard: host identity card top stripe thickened; System Updates card gains a coloured top stripe' },
    ],
  },
  {
    version: '1.8.4',
    date: '2026-05-01',
    changes: [
      { type: 'changed', text: 'Settings page sections redesigned to match the Dashboard layout — space-y-8 between sections, small uppercase tracking label with primary left accent bar replacing plain headings' },
    ],
  },
  {
    version: '1.8.3',
    date: '2026-05-01',
    changes: [
      { type: 'changed', text: 'Settings — Host Configuration section now shows a tip explaining that BACKUP_ROOT can point to a mounted second disk or NAS share (NFS, SMB, iSCSI) to keep backups off the primary storage pool' },
    ],
  },
  {
    version: '1.8.2',
    date: '2026-05-01',
    changes: [
      { type: 'changed', text: 'Templates, ISOs, Networks, Virtual Machines, SSH Keys, and Storage pages all have stat cards at the top with coloured icon accents, matching the Backups page pattern' },
      { type: 'changed', text: 'Storage ResourceCard updated to icon-left layout with per-type colour accents (violet/blue/emerald)' },
      { type: 'changed', text: 'Virtual Machines page subtitle simplified; VM counts moved into stat cards' },
    ],
  },
  {
    version: '1.8.1',
    date: '2026-05-01',
    changes: [
      { type: 'changed', text: 'UI consistency pass: standardised card shadows, empty-state layout, table header and row styles across all pages' },
      { type: 'changed', text: 'Spinner component used consistently — replaced ad-hoc Loader2 usage in VmConsole and Login' },
      { type: 'changed', text: 'Physical NIC picker in Create Network dialog uses the Select component' },
      { type: 'changed', text: '"History →" link in the Backups table uses the Button ghost variant' },
    ],
  },
  {
    version: '1.8.0',
    date: '2026-05-01',
    changes: [
      { type: 'added', text: 'Backup progress indicator — a live in-progress row appears at the top of the per-VM backup table while a backup is running (manual or scheduled), with spinner and animated progress bar; the backup list also shows a progress bar under the VM name and "Backing up…" in the Last Backup column; indicator persists on page navigation via a polled backend endpoint' },
      { type: 'fixed', text: 'Large backup and restore operations no longer time out — Axios timeout disabled for create-backup and restore calls which can take many minutes on large disks' },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'Two-factor authentication — enable TOTP-based 2FA in Settings; when active, login requires a 6-digit code from an authenticator app after the password; 2FA can be removed at any time from Settings' },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'IP Access Control — whitelist specific IPs or CIDR ranges in Settings; when the list is non-empty only those addresses can log in or call the API/WebSocket; empty list preserves existing open-access behaviour' },
    ],
  },
  {
    version: '1.5.1',
    date: '2026-04-30',
    changes: [
      { type: 'changed', text: 'VM Overview resource cards now have colour-coded icon accents (blue/violet/amber/teal) and larger value numerals' },
      { type: 'added', text: 'Copy-to-clipboard buttons on VM Overview for IP address, username, password, SSH command, and UUID — icon flips to a green check on success' },
      { type: 'changed', text: 'VM Overview section headings changed to compact uppercase tracking style' },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'VM rename — pencil icon next to the VM name on the detail page (stopped VMs only); renames the libvirt domain and updates all associated metadata, port forwards, DHCP reservations, and firewall config' },
    ],
  },
  {
    version: '1.4.3',
    date: '2026-04-30',
    changes: [
      { type: 'changed', text: 'Sidebar collapse toggle moved into the brand bar — to the right of the logo when expanded, below it when collapsed' },
      { type: 'changed', text: 'Sign out is now a full-width labelled button with a red hover state, replacing the small unlabelled icon in the footer' },
    ],
  },
  {
    version: '1.4.2',
    date: '2026-04-30',
    changes: [
      { type: 'fixed', text: 'APT upgrade terminal no longer colours stderr red — apt-get uses stderr for normal progress output; failure is indicated by the footer exit-code status instead' },
    ],
  },
  {
    version: '1.4.1',
    date: '2026-04-30',
    changes: [
      { type: 'fixed', text: 'Metric card left panel widened so long values like "159.98 B/s" no longer overflow in the two-column grid' },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-04-30',
    changes: [
      { type: 'changed', text: 'Dashboard redesigned — host identity card + 2×2 stat grid replaces the five-tile row; four metric sections collapsed into a 2×2 live metrics grid' },
      { type: 'added',   text: 'Host card shows hostname, CPU model and core count, colour-coded load averages, and live network RX/TX from a new /api/system/info endpoint' },
      { type: 'added',   text: 'Progress bars on Disk Space and Memory tiles; VM status dots on the Virtual Machines tile' },
      { type: 'changed', text: 'About section removed from the dashboard' },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'SSH Keys page — save public keys with a friendly name and select them during VM provisioning' },
      { type: 'added', text: 'VM creation wizard now shows a checkbox picker for saved SSH keys instead of a free-form textarea' },
    ],
  },
  {
    version: '1.2.6',
    date: '2026-04-30',
    changes: [
      { type: 'fixed', text: 'Deleting a VM with UEFI/Secure Boot or vTPM no longer fails — virsh undefine now includes --nvram and --tpm to clean up associated state files' },
    ],
  },
  {
    version: '1.2.5',
    date: '2026-04-30',
    changes: [
      { type: 'changed', text: 'Resources section shows a hint to shut down the VM when CPU/memory editing is unavailable' },
    ],
  },
  {
    version: '1.2.4',
    date: '2026-04-30',
    changes: [
      { type: 'fixed', text: 'Secure Boot VMs now boot with Microsoft keys pre-enrolled (OVMF_VARS.ms.fd template) — previously the firmware started in Setup Mode so Secure Boot was always disabled inside the guest' },
    ],
  },
  {
    version: '1.2.3',
    date: '2026-04-30',
    changes: [
      { type: 'changed', text: 'Resource Edit button is now always visible on the Overview tab — disabled with a tooltip when the VM is running, rather than hidden' },
    ],
  },
  {
    version: '1.2.2',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'Virtual TPM 2.0 — enables full Windows 11 compatibility; emulated via libvirt\'s TPM backend' },
    ],
  },
  {
    version: '1.2.1',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'UEFI/OVMF firmware support with optional Secure Boot — selectable at VM creation time' },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'VM autostart — toggle in the Overview tab configures whether a VM starts automatically when the host boots (virsh autostart)' },
      { type: 'added', text: 'Disk resize — grow any attached disk from the Disks tab; the hypervisor is notified immediately if the VM is running (guest still needs to resize partition/filesystem internally)' },
      { type: 'added', text: 'Resource editing — edit vCPU count and memory while the VM is stopped; changes are applied to the domain definition and take effect on next boot' },
      { type: 'added', text: 'Per-VM metrics — new Metrics tab shows live CPU%, memory, disk I/O, and network I/O for running VMs using virsh domstats, with rolling area charts' },
    ],
  },
  {
    version: '1.1.8',
    date: '2026-04-30',
    changes: [
      { type: 'changed', text: 'PCI device list uses an allowlist — only legitimate passthrough targets (Storage, Network, Display, Multimedia, Input, Serial Bus, Wireless, Encryption, Signal Processing) are shown; processor sub-functions, bridges, memory controllers, and system peripherals are hidden' },
    ],
  },
  {
    version: '1.1.7',
    date: '2026-04-30',
    changes: [
      { type: 'changed', text: 'Available PCI devices whose kernel driver is not vfio-pci now show an amber warning icon next to the driver name — tooltip warns that attaching will unbind the device from the host' },
    ],
  },
  {
    version: '1.1.6',
    date: '2026-04-30',
    changes: [
      { type: 'added', text: 'PCI and USB device passthrough — new Devices tab on VM detail page lets you attach and detach host devices to VMs; devices in use by another VM are shown but cannot be claimed' },
      { type: 'added', text: 'PCI devices show address (DDDD:BB:SS.F), class, IOMMU group, and current driver; USB devices show bus and device number' },
    ],
  },
  {
    version: '1.1.5',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: '"Add NIC" messaging is now OS-neutral — snippet is labelled as an Ubuntu/Debian (netplan) example with a note to adapt for other distributions or Windows' },
    ],
  },
  {
    version: '1.1.4',
    date: '2026-04-29',
    changes: [
      { type: 'fixed', text: 'Existing-bridge networks now labelled "OS Bridge DHCP" / "OS Bridge Static" in VM creation and VM detail — previously indistinguishable from VirtPilot-managed bridges' },
    ],
  },
  {
    version: '1.1.3',
    date: '2026-04-29',
    changes: [
      { type: 'fixed', text: '"Add NIC" now records the new interface in VM metadata — network tab shows correct network name and IP on reload' },
      { type: 'fixed', text: 'Removing a NIC now removes its metadata entry and releases any static IP allocation back to the pool' },
      { type: 'fixed', text: '"DHCP · unresolved" now shown correctly for existing-bridge DHCP NICs instead of "—"' },
      { type: 'changed', text: 'Backend pins the MAC via --mac flag when attaching; allocated MAC matches what is stored in metadata' },
      { type: 'changed', text: '"Add NIC" dialog shows an IP picker for static networks and requires a selection before confirming' },
      { type: 'changed', text: 'After adding a NIC, a ready-to-paste netplan snippet is shown with the correct MAC and IP configuration' },
    ],
  },
  {
    version: '1.1.2',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: '"Allow established & related" checkboxes are disabled when the default policy is "Allow all" — redundant in that state' },
      { type: 'changed', text: 'Switching default policy to "Drop all" auto-enables the established & related checkbox; switching back to "Allow all" clears it' },
    ],
  },
  {
    version: '1.1.1',
    date: '2026-04-29',
    changes: [
      { type: 'fixed', text: '"Allow established & related" checkboxes now persist correctly' },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-04-29',
    changes: [
      { type: 'added', text: 'Firewall rule reordering with up/down buttons on each row' },
      { type: 'added', text: 'Multi-port firewall rules — comma-separated ports and ranges (e.g. 80,443 or 80,8000-9000)' },
      { type: 'added', text: 'ICMP type filtering — select specific ICMP types (echo-request, echo-reply, etc.)' },
      { type: 'added', text: 'Stateful connection tracking — allow established & related connections per direction' },
      { type: 'changed', text: 'Port field shows "any" in rules table when no port restriction is set' },
    ],
  },
  {
    version: '1.0.15',
    date: '2026-04-29',
    changes: [
      { type: 'added', text: 'Firewall rules support source address (inbound) and destination address (outbound)' },
      { type: 'added', text: 'Edit button on each firewall rule row to modify rules in place' },
    ],
  },
  {
    version: '1.0.14',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'Sidebar is always dark regardless of page theme' },
    ],
  },
  {
    version: '1.0.13',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'Sidebar brand area replaced with PNG logo: full wordmark when expanded, icon-only when collapsed' },
    ],
  },
  {
    version: '1.0.12',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'Visual polish pass: radial bloom background, airy card shadows, staggered fade-up entrance, glow-pulse status dots' },
      { type: 'changed', text: 'Sidebar switches to cool off-white in light mode; light mode is now the default theme' },
      { type: 'changed', text: 'Dashboard: MetricCard gradient divider, gradient metric values, per-card chart colour wash' },
      { type: 'changed', text: 'SectionLabel, StatTile, AboutSection, NavItem all receive premium gradient and motion treatments' },
    ],
  },
  {
    version: '1.0.11',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'Sidebar restyled to match HostedAI Launchpad: bg-sidebar token, left-border active state, semantic colour tokens' },
      { type: 'changed', text: 'Card rounding standardised to rounded-xl across all pages' },
    ],
  },
  {
    version: '1.0.10',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'System Updates overview tile shows count only, without "pending" label' },
    ],
  },
  {
    version: '1.0.9',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'Dashboard metric graphs each full width in their own section (CPU, Memory, Disk I/O, Network)' },
    ],
  },
  {
    version: '1.0.8',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'System Updates card is now full width on the dashboard' },
      { type: 'changed', text: 'Virtual Machines card removed from dashboard' },
    ],
  },
  {
    version: '1.0.7',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'Host Configuration moved from dashboard to Settings page' },
    ],
  },
  {
    version: '1.0.6',
    date: '2026-04-29',
    changes: [
      { type: 'fixed', text: 'APT upgrade streaming broken: EventSource now passes JWT as query param since browser EventSource cannot set headers' },
    ],
  },
  {
    version: '1.0.5',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'About section moved below Overview, full-width with expanded detail and GitHub link' },
      { type: 'changed', text: 'Release notes removed from dashboard in favour of GitHub repo link' },
    ],
  },
  {
    version: '1.0.4',
    date: '2026-04-29',
    changes: [
      { type: 'changed', text: 'Host Configuration displayed as borderless key-value layout below System cards' },
      { type: 'changed', text: 'About section rendered as borderless text layout, no card chrome' },
    ],
  },
  {
    version: '1.0.3',
    date: '2026-04-29',
    changes: [
      { type: 'fixed', text: 'Dashboard section cards now match height within each row' },
    ],
  },
  {
    version: '1.0.2',
    date: '2026-04-29',
    changes: [
      { type: 'added', text: 'About section on dashboard showing software info and release notes' },
    ],
  },
  {
    version: '1.0.1',
    date: '2026-04-29',
    changes: [
      { type: 'added',   text: 'Guest agent status display on VM overview' },
      { type: 'added',   text: 'Freeze/thaw filesystems on snapshot for guest-agent-enabled VMs' },
      { type: 'added',   text: 'Hard reset and force-off actions on VM detail page' },
      { type: 'added',   text: 'Persist template/ISO upload progress across navigation with cancel' },
      { type: 'changed', text: 'Lighten sidebar version label for legibility' },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-04-28',
    changes: [
      { type: 'added', text: 'Initial release (rebranded from ptmvm)' },
      { type: 'added', text: 'KVM/QEMU VM management via libvirt (create, start, stop, delete, snapshot)' },
      { type: 'added', text: 'Serial console access via WebSocket and xterm.js' },
      { type: 'added', text: 'VNC remote display via noVNC' },
      { type: 'added', text: 'Cloud-init provisioning with static IP support' },
      { type: 'added', text: 'Network management: bridged and NAT (libvirt networks)' },
      { type: 'added', text: 'Firewall rules via iptables with per-VM chains' },
      { type: 'added', text: 'Template and ISO file management with upload progress tracking' },
      { type: 'added', text: 'Live system metrics dashboard (CPU, memory, disk I/O, network)' },
      { type: 'added', text: 'APT system update management with streaming upgrade terminal' },
      { type: 'added', text: 'Self-contained installer (install.sh) and in-place updater (update.sh)' },
      { type: 'added', text: 'Port forwarding management' },
    ],
  },
];
