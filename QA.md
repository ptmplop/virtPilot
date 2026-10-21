# QA — VirtPilot

A full-system smoke pass against a clean install. Run after every release; record findings, deltas, and version-introduced regressions inline. **The intent is a re-runnable script, not a one-off log.**

## How to use

1. Spin up a fresh Ubuntu 24.04 host. Run `bootstrap.sh` to install the version under test.
2. Set `HOST=<ip>`, `URL=https://$HOST:3001`. Note the password printed by `install.sh`.
3. Get an auth token for API calls:
   ```bash
   TOKEN=$(curl -sk -X POST "$URL/api/auth/login" -H 'Content-Type: application/json' \
     -d "{\"password\":\"$PASS\"}" | jq -r .token)
   ```
4. Walk through the sections below. Tick (✓) what passes, leave a note for what fails. Add new tests as the surface grows; never delete a test — mark it superseded.

Each section ends with a "Cleanup" so the next section starts from a known state. The doc is meant to be runnable as a single sitting (~30 min for a full pass) or piecemeal section-by-section.

## Sections

1. [Smoke test](#1-smoke-test) — service is up, dashboard loads, login works
2. [Storage directories CRUD](#2-storage-directories-crud) — register / edit / delete dirs, validation
3. [Templates](#3-templates) — upload, URL download, rename, delete, multi-dir picker, location column
4. [ISOs](#4-isos) — same shape as templates plus compression handling
5. [VM lifecycle on default storage](#5-vm-lifecycle-on-default-storage) — happy path: create, start, console, delete
6. [VM lifecycle on a non-default storage dir](#6-vm-lifecycle-on-a-non-default-storage-dir) — disks land in chosen dir; control state stays on system root
7. [Move flows](#7-move-flows) — template / ISO / VM disk move; reference guards; cross-fs
8. [Missing-file detection](#8-missing-file-detection) — manual `mv` outside the dashboard surfaces an alert
9. [Backup + restore](#9-backup--restore) — create backup, restore into existing VM, restore lands in correct storage dir
10. [Snapshots](#10-snapshots) — create, revert, delete, snapshot-to-template
11. [Networks](#11-networks) — NAT, bridged, port forwards
12. [Negative tests](#12-negative-tests) — bad inputs, racy edges, refused operations
13. [Self-upgrade](#13-self-upgrade) — in-dashboard update flow
14. [Incremental backups](#14-incremental-backups) — checkpoints, chains, retention, chain-aware delete
15. [Backup consistency mechanism](#15-backup-consistency-mechanism) — which copy tier ran, and the freeze window
16. [Restore into a new VM](#16-restore-into-a-new-vm) — rebuild a whole machine from a backup
17. [Clone](#17-clone) — independent copy of a running or stopped VM
18. [Device passthrough](#18-device-passthrough) — host checks, what is offered, groups, GPU end to end, SR-IOV, keep for VMs

---

## 1. Smoke test

```bash
ssh root@$HOST "systemctl is-active virtpilot && curl -sk $URL/health"
```
Expect `active` and `{"ok":true}`.

Open `$URL` in a browser. Bypass cert warning. Login with the install-time password. Dashboard renders without errors. Check the sidebar version footer — should match `package.json`.

`journalctl -u virtpilot -n 50` should show no stack traces.

---

## 2. Storage directories CRUD

### 2.1 Default seeded

Confirm exactly one row exists, marked default for all three purposes:

```bash
ssh root@$HOST "sqlite3 -header -column /var/lib/virtpilot/virtpilot.db \
  'SELECT name, path, purposes, is_default_templates AS t, is_default_isos AS i, is_default_vm_disks AS v FROM storage_dirs'"
```

### 2.2 Add a second dir

On the host:
```bash
ssh root@$HOST "mkdir -p /opt/virtpilot-test && chown virtpilot:virtpilot /opt/virtpilot-test && chmod 0770 /opt/virtpilot-test"
```

In the dashboard → Storage → "Add directory":
- Name: `Test`
- Path: `/opt/virtpilot-test`
- Purposes: tick all three
- Set as default: leave off

Expect: row appears, free/used bar shows the dir's filesystem totals, `Local` retains all three default flags.

### 2.3 Validation

Try each of these; backend should reject with a 400:

| Path | Reason |
|---|---|
| `relative/path` | not absolute |
| `/etc` | system path |
| `/var/lib/virtpilot/cloud-init` | reserved subdir |
| `/var/lib/virtpilot/.uploads` | reserved subdir |
| `/usr/local/virtpilot` | install dir |
| `/nonexistent/path` | does not exist |
| `/etc/passwd` | is a file, not a dir |

Operator-supplied paths with `$` (e.g. `/opt/foo$bar`) should work — validation accepts them. We test the `$`-in-path bug specifically in [Section 7](#7-move-flows).

### 2.4 Edit + default-shifting

Edit `Test` → tick "Use as default for templates". Expect `Local`'s templates-default flag clears; `Test` becomes the templates default. ISOs / VM-disks defaults stay on `Local`.

### 2.5 Delete

Delete `Test` while empty: succeeds. Re-add it. Upload a template into it (see Section 3). Try to delete: refused with "still holds N template(s)". Cleanup that template, then delete. Succeeds.

---

## 3. Templates

### 3.1 Upload to default

Templates page → Upload Template. Pick a small qcow2 (build a 100 MB one if needed: `qemu-img create -f qcow2 /tmp/test.qcow2 100M`). Display name: "Test template". Storage dropdown: pre-filled to `Local` (default). Submit.

Expect: appears in the list with location "Local", size ~100 MB. SSH check:
```bash
ssh root@$HOST "ls -la /var/lib/virtpilot/templates/"
```

### 3.2 Upload to non-default

Add `Test` storage dir if not present. Re-upload, picking `Test`. Verify it lands at `/opt/virtpilot-test/templates/`.

### 3.3 URL download

Templates → From URL. Use a known-small cloud image (or a self-hosted file). Pick `Test` as storage. Verify the download progress bar fills, the file lands at `/opt/virtpilot-test/templates/`, and the listing shows it.

### 3.4 Rename + delete

Click name to inline-rename; verify it persists across reload (`<file>.meta.json` written). Delete; verify file removed from disk.

---

## 4. ISOs

Same shape as templates: upload (.iso, .iso.gz, .iso.tar.gz), URL download, rename, delete, location column, storage dropdown. Validate that compression decompresses on the server (the gz/tgz cases should land as `.iso` on disk).

```bash
ssh root@$HOST "ls -la /var/lib/virtpilot/isos/ /opt/virtpilot-test/isos/ 2>/dev/null"
```

---

## 5. VM lifecycle on default storage

### 5.1 Create from template

Pick the upload from 3.1. Storage: `Local`. Networks: pick `myNet` (default NAT). Submit. Wait for create to finish.

```bash
ssh root@$HOST "
  ls -la /var/lib/virtpilot/vms/<uuid>/
  sqlite3 /var/lib/virtpilot/virtpilot.db 'SELECT * FROM vm_disk_locations'
"
```

Expect: `disk.qcow2`, `<uuid>-nvram.fd`, `name.txt` in the system root vmDir; vm_disk_locations row pointing at `Local`'s id.

### 5.2 Start, console, stop

Start the VM. Open the console. Confirm boot proceeds. Stop.

### 5.3 Add an extra disk

VM detail → Disks → Add Disk. 5 GB on `Local`. Verify file appears at `<systemVmDir>/extra-disk-1.qcow2` and a row appears in `vm_disk_locations`.

### 5.4 Delete VM (with storage)

Delete with "remove storage". Verify:
- libvirt no longer knows the VM
- vmDir is gone
- vm_disk_locations rows for that uuid are gone
- cloud-init artefacts gone

---

## 6. VM lifecycle on a non-default storage dir

### 6.1 Create

Same as 5.1 but pick `Test` as the storage. Verify:
- Disk lives at `/opt/virtpilot-test/vms/<uuid>/disk.qcow2`
- NVRAM + `name.txt` live at `/var/lib/virtpilot/vms/<uuid>/`
- Cloud-init seed at `/var/lib/virtpilot/cloud-init/<uuid>-seed.iso`
- Domain XML references the absolute disk path under `/opt/virtpilot-test/...`

### 6.2 Boot

Start VM. Confirms libvirt-qemu can read from the non-default mount.

### 6.3 Add disk on a third dir

Register a third storage dir with vmDisks purpose. Add an extra disk on it. The VM now has its primary on `Test`, an extra on the third dir, and control state on `Local`. All three should be readable + the VM starts.

---

## 7. Move flows

### 7.1 Move template

Upload a template to `Local`. From the Templates row, click the move icon. Pick `Test`. Confirm:
- File is moved on disk
- Listing shows the new location
- `.meta.json` followed it

### 7.2 Move template — refused when in use

Create a VM from the template. Try to move it: backend returns 409 listing the affected VM. Toast surfaces the error.

### 7.3 Move ISO

Upload an ISO. Move from `Local` to `Test`. Verify file move + meta move.

### 7.4 Move ISO — refused when attached as CDROM

Attach the ISO to a VM as a CDROM. Try to move: 409 with VM name. Detach, retry: succeeds.

### 7.5 Move VM disk — three-phase commit

Stop the VM. Storage page → VM Disks → Move icon. Pick a different vmDisks dir. Verify:
- File moves
- `vm_disk_locations` row updates
- Domain XML updates: `virsh dumpxml <uuid> | grep "<source file"` shows the new path
- VM starts cleanly from the new location

### 7.6 Move VM disk — refused when running

VM running → move icon disabled or backend returns 409.

### 7.7 Path with `$`

Register a storage dir with `$` in the name (e.g. `/mnt/has$dollar`). Move a template into it. Move a VM disk into it. The `$` regression test for `replaceDiskSource`.

```bash
ssh root@$HOST "mkdir -p /mnt/has\\\$dollar && chown virtpilot:virtpilot /mnt/has\\\$dollar"
```

Expected: domain XML correctly references `/mnt/has$dollar/vms/<uuid>/disk.qcow2`. VM starts.

### 7.8 Cross-filesystem move

If a separate mount is available (e.g., a second disk, or `mount --bind` a tmpfs to simulate), register it as a storage dir, then move a template / VM disk into it. The move uses `copyFile + unlink` because `rename` fails with EXDEV. Verify file ends up at the destination, source is gone.

---

## 8. Missing-file detection

### 8.1 VM disk vanishes

Stop a VM. As root, manually `mv` its disk file out of the storage dir:

```bash
ssh root@$HOST "mv /opt/virtpilot-test/vms/<uuid>/disk.qcow2 /tmp/"
```

Refresh the VM detail page. Expect:
- Amber "missing" badge next to the disk's `vda` target
- Source path text turns amber
- Tooltip explains the VM will fail to start

Try to start the VM. Should fail with a libvirt error about missing disk file.

### 8.2 Restore the file

`mv` it back. Refresh: badge clears.

### 8.3 ISO vanishes

VM with ISO attached → manually delete the ISO file. Attempting to start the VM produces a libvirt error. (We don't currently surface this on the Storage page — this is documented as out-of-scope; ISO listings just stop showing the file.)

---

## 9. Backup + restore

### 9.1 Create backup

VM detail → Backups → Create Backup. Wait for completion.

```bash
ssh root@$HOST "ls -la /var/lib/virtpilot/backups/<uuid>/"
```

Verify: `<id>/disk.qcow2`, `<id>/manifest.json`, `<id>/.complete`.

### 9.2 Restore into existing VM

Restore the backup into the same VM. Verify:
- Backup files copied to the storage dir the VM's disk lives in (NOT blindly to `/var/lib/virtpilot/vms/`)
- `vm_disk_locations` row matches
- VM still starts after restore

This validates the v2.3 backup-restore-on-non-default fix.

### 9.3 Restore on a non-default-dir VM

Restore a VM whose disks live on `Test`. Files must land at `/opt/virtpilot-test/vms/<uuid>/`.

---

## 10. Snapshots

Create snapshot, take notes inside the VM, revert, verify VM is back to the snapshot state. Delete the snapshot. Snapshot-to-template (writes a new template into the chosen storage dir).

---

## 11. Networks

NAT network exists by default (`myNet`). Create a bridged network if a free NIC is available. Add port forwards. Verify iptables rules land:

```bash
ssh root@$HOST "iptables -t nat -L PREROUTING -n; iptables -L FORWARD -n | head"
```

Delete a port forward; verify rules torn down.

---

## 12. Negative tests

| Test | Expected |
|---|---|
| Login with wrong password | 401, no token |
| API call without bearer | 401 |
| Create VM with same name twice | 409 |
| Delete the seeded `Local` storage dir while it holds VMs | 400 with disk count |
| Move template to a dir not flagged for templates | 400 |
| Path containing `..` in storage dir registration | 400 |
| Upload template with `../../etc/cron.d/x` filename | rejected by FILENAME_RE |
| Stop the libvirt service then refresh VM list | UI degrades gracefully (empty list, no crash) |

---

## 13. Self-upgrade

Optional — only run when there's a newer release tag.

Settings → System → Check for updates. Initiate. Watch the SSE stream. Verify:
- `update.sh` runs
- Service restarts
- New version shows in the sidebar footer
- VMs are unaffected

---

## 14. Incremental backups

Requires a **running** VM on a host where `virsh domcapabilities | grep "<backup"`
reports `supported='yes'`.

### 14.1 First full records a checkpoint

```bash
curl -sk -X POST "$URL/api/backups/$VM" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"kind":"full"}' | jq '.backup | {id,kind,method,consistency}'
ssh root@$HOST "virsh checkpoint-list $VM --name"
```
Expect `kind: "full"`, `method: "libvirt-backup"`, and one `vpbk-<backup-id>` checkpoint.

### 14.2 Incremental is genuinely a delta

Write a known file inside the guest, then:
```bash
curl -sk -X POST "$URL/api/backups/$VM" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"kind":"incremental"}' | jq '.backup | {id,kind,parentBackupId}'
ssh root@$HOST "du -sh /var/lib/virtpilot/backups/$VM/*/"
```
The incremental directory must be **dramatically smaller** than the full. Confirm
the backing pointer is relative:
```bash
ssh root@$HOST "qemu-img info /var/lib/virtpilot/backups/$VM/<inc-id>/disk.qcow2 | grep -i backing"
```
Expect `backing file: ../<full-id>/disk.qcow2`.

### 14.3 Chain restores as one image

Restore the incremental into a new VM (Section 16) and confirm the file written
in 14.2 is present in the guest, *and* that files written before the full backup
are still there. This is the test that proves the chain is being read end to end
rather than the delta alone.

### 14.4 Incremental with no parent falls back to full

Delete every backup for a VM, then ask for an incremental. Expect `kind: "full"`
and a `notes` entry explaining the fallback. The API must return 200 — a schedule
must never skip a run.

### 14.5 Incremental against a stopped VM falls back to full

Stop the VM, request `kind=incremental`. Expect `kind: "full"`,
`method: "offline-convert"`, and a note naming the reason.

### 14.6 Deleting a parent is refused

```bash
curl -sk -X DELETE "$URL/api/backups/$VM/<full-id>" -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}\n'
```
Expect **409** and `requiresCascade: true`. Then:
```bash
curl -sk -X DELETE "$URL/api/backups/$VM/<full-id>?cascade=true" -H "Authorization: Bearer $TOKEN"
```
Expect 200, and both the full and its incrementals gone from disk.

### 14.7 Retention keeps a parent alive

Set a 1-day retention, backdate the full backup's `createdAt` in its manifest,
leave the incremental recent, and trigger retention (create another backup).
The expired full must **survive**, because the incremental still needs it.

### 14.8 Chain-broken detection

Manually `rm -rf` a full backup's directory, then list backups. Its incrementals
must come back with `chainBroken: true`, the UI must show a "Chain broken" badge,
and Restore must be disabled. Attempting a restore via the API must 500 with a
message about a missing ancestor, **not** produce a corrupt disk.

### 14.9 Stale checkpoint sweep

Delete a backup directory by hand, then take a new backup. The orphaned
`vpbk-` checkpoint must be gone from `virsh checkpoint-list`.

### Cleanup

Delete all test backups; confirm `virsh checkpoint-list $VM --name` is empty.

---

## 15. Backup consistency mechanism

### 15.1 Guest agent present → app-consistent, short freeze

With `qemu-guest-agent` running in the guest, start a backup of a large disk and
watch the guest's I/O. The freeze must last **under a second**, not the duration
of the copy. Verify with a clock loop inside the guest:
```bash
# in the guest, while the backup runs
while true; do date +%s.%N >> /tmp/tick; sleep 0.1; done
```
No gap longer than ~1s. The backup's `consistency` must be `app-consistent`.

**Regression guard:** before 2.7 this gap was the entire copy duration.

### 15.2 No guest agent → crash-consistent, still no stall

Stop `qemu-guest-agent` in the guest and repeat. Expect
`consistency: "crash-consistent"`, `method: "libvirt-backup"`, and a note saying
the guest agent was unavailable. The guest must still not stall.

### 15.3 Offline backup

Stop the VM, back it up. Expect `method: "offline-convert"`,
`consistency: "offline"`.

### 15.4 Compression

Enable compression in Settings, take a full backup of a running VM. The image
must be measurably smaller than uncompressed, and `qemu-img info` should not
error. Incrementals are never compressed by design — confirm an incremental
taken with compression on still restores.

---

## 16. Restore into a new VM

### 16.1 Happy path

```bash
curl -sk -X POST "$URL/api/backups/$VM/<backup-id>/restore-as-new" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"restored-01","start":true}' | jq
```
Verify:
- New VM appears with a **different UUID** and **different MAC addresses**
  (`virsh domiflist` on both).
- Disks land under the chosen storage dir, `vm_disk_locations` has rows.
- A UEFI source produces its own `<uuid>-nvram.fd` — not the original's path
  (`virsh dumpxml restored-01 | grep nvram`).
- VNC port does not clash: both VMs run simultaneously.
- The guest boots with `restored-01` as its hostname (cloud-init re-ran because
  instance-id changed).

### 16.2 Source VM deleted

Delete the original VM entirely, then restore-as-new from its orphaned backup.
Must succeed — this is the whole point of the feature.

### 16.3 Static-IP network allocates a fresh address

With the source on a static bridge network, the restored VM must get a
**different** free IP, recorded in `ip-allocations.json`, and the response must
carry a warning naming both addresses.

### 16.4 Name collision

Restore-as-new using an existing VM's name. Expect **409**, and no orphaned
disks left behind (`ls` the storage dir).

### 16.5 Rollback on failure

Force a failure mid-provision (e.g. fill the storage dir, or point at a
storage dir the service cannot write). Expect no leftover disks, no leftover IP
allocation, no half-defined domain.

---

## 17. Clone

### 17.1 Clone a stopped VM

Expect `method: offline-convert` behaviour, a fully independent disk
(`qemu-img info` on the clone shows **no backing file** pointing at the source),
new UUID/MACs/NVRAM, and both VMs bootable at once.

### 17.2 Clone a running VM

The source must stay running throughout and must not stall (same clock-loop
check as 15.1). Response `consistency` is `app-consistent` with a guest agent,
`crash-consistent` without.

### 17.3 Clone leaves no checkpoint behind

```bash
ssh root@$HOST "virsh checkpoint-list <source-vm> --name"
```
Must be unchanged by the clone — checkpoints belong to the backup engine only.

### 17.4 Identity regeneration off

Clone with `regenerateCloudInit: false`. The clone keeps the original hostname
and credentials; confirm the dialog warned about the duplicated static IP.

### 17.5 Concurrent clone refused

Fire two clones of the same source at once. The second must return **409**, not
corrupt the first.

### 17.6 Attached ISO carried over, seed not

A source with an ISO on `sdb` and a cloud-init seed on `sda`: the clone keeps the
ISO and gets its **own** seed (or an ejected `sda` if the source had no cloud-init).
`virsh dumpxml` on the clone must contain no reference to the source's UUID.

---

## 18. Device passthrough

Needs bare metal (or a VM with an emulated IOMMU) with VT-x/AMD-V and VT-d/AMD-Vi on. The 2026-10-21 run used an
Intel S2600BP (2× Xeon Silver 4114) with an NVIDIA L4, a BlueField-3 (ConnectX-7) and an Intel X550.

### 18.1 Host checks

`GET $URL/api/devices` → `host.checks`. With VT-x/VT-d off in the firmware: `pciReady: false`, "Hardware
virtualisation: Off in the firmware settings" (the journal's "VMX (outside TXT) disabled by BIOS" is what tells
firmware-off from unsupported), IOMMU "Off in the firmware settings" (no DMAR table), interrupt remapping "Needs the
IOMMU first". With them on: all four ok, and the Devices page folds the checks to one line.

### 18.2 What is offered

Every PCI function is offered, travels inside an offered device's group, or is hidden with a reason
(`devices + members + hidden == lspci count`). The host's root-disk controller, the NIC with the default route and the
BMC VGA (connector enabled) must be hidden as "host". `POST /api/vms/$UUID/devices {"deviceId":"pci_<root nvme>"}` must
refuse with the reason.

### 18.3 Groups

Attach a device whose group-mate has a host driver (bp8: xHCI `00:14.0` with the PCH thermal sensor `00:14.2`): both
hostdevs land in the config, the VM starts, the guest sees both. Before 2.15.0 this failed with "group 39 is not viable".

### 18.4 GPU end to end

UEFI VM, attach the GPU, start, install the vendor driver in the guest (`ubuntu-drivers install --gpgpu` plus
`nvidia-utils-<n>-server`), `nvidia-smi` shows the card and its full memory. Stop (graceful and forced), start again:
the card comes back. On BIOS firmware the attach is refused (SeaBIOS cannot place a 32 GB BAR; the guest crashed with
`KVM_SET_USER_MEMORY_REGION failed`).

### 18.5 Live changes

Running VM: a NIC or HBA attaches and detaches live (the host driver takes it back); a GPU or a group attaches and
detaches at the next start/stop, with Undo for a pending detach; a chipset-integrated endpoint ("No more available PCI
slots" live) joins at the next start. USB attaches and detaches live, and shows as one row (libvirt adds the bus and
device number to the running copy).

### 18.6 Before a start

Each refuses with words: a hostdev for an address that doesn't exist (`virsh attach-device --config` accepts one), a
group-mate still on a host driver, the device in another running VM, guest memory above MemAvailable, a big-BAR card on
BIOS. A missing device's row has a working Detach.

### 18.7 Snapshots, clones, backups

Running VM with a PCI device: snapshot succeeds (disk-only, external), the VM stops and starts again (the chain cache is
dropped; before 2.15.0 a template-based VM failed with "Permission denied" on the template under AppArmor), revert keeps
the devices. Clone: no hostdevs, and a warning says the devices stayed. Backup of the running GPU VM: libvirt tier, OK.

### 18.8 Keep for VMs and virtual functions

Keep a device: `driver_override` is `vfio-pci`, `/etc/virtpilot/passthrough.conf` has `keep <addr>`, and after a VM
using it stops it stays on vfio-pci. Set virtual functions on an SR-IOV NIC: they appear as offered network cards in
their own groups, and one passes through (the guest's mlx5_core binds it). Reboot: `virtpilot-passthrough.service`
runs before libvirtd and both settings are back.

### Cleanup

Detach every device, give kept devices back, set virtual functions to 0, delete the test VMs.

---

## Findings log

Append per-run findings here. Format: `### YYYY-MM-DD — vX.Y.Z (host)` then bullet list.

### 2026-10-21 — v2.15.0 (bp8, bare metal, owner's test server)

A clean Ubuntu 24.04 install (kernel 6.8.0-147) with the real one-liner: 2.5 minutes, no errors. The BIOS had both
VT-x and VT-d switched off; they were switched on from the OS with Intel's Server Configuration Utility (syscfg 16.0.13,
checksum verified against Intel's page; `syscfg /bcs "" "Intel(R) Virtualization Technology" 1` and the same for
"Intel(R) VT for Directed I/O"), then a reboot. Ubuntu's kernel has `CONFIG_INTEL_IOMMU_DEFAULT_ON=y`, so no kernel
flag was needed. Section 18 passed in full. Found and fixed on the way (all in the 2.15.0 notes):

- 2.14.0 listed 27 devices, among them the root NVMe, the management NIC and two USB root hubs; and a VM's own devices
  appeared under "In use by other VMs" with no Detach (ID compared with name).
- A running VM with a PCI device could not be snapshotted (VFIO migration).
- Any template-based VM with a disk-only snapshot could not start again (AppArmor and the cached chain).
- BIOS + L4 crashed the guest at once; clones copied hostdevs; USB showed twice while running.
- The installer let debconf fall through three frontends; needrestart could prompt on a terminal.

Observed, not fixed (outside VirtPilot): in 3 of the 6 restarts that followed snapshot activity on the running GPU VM
(a snapshot then a forced power-off, or a revert), the guest's NVIDIA 595 driver hung at load on the next boot (its
console stops at "NVRM: loading NVIDIA UNIX Open Kernel Module", or udev never creates /dev/disk/by-label/BOOT and the
guest drops to emergency mode). A Hard reset recovered it every time. A snapshot then a clean shutdown, and plain forced
power-offs (6 of 6), never showed it. No Xid errors in the guest after a snapshot, nothing in the host's log.

The test run's own trap: the service user's home is the install directory, so an `rsync --delete` into it removed
`~/.ssh` (the key VirtPilot injects into VMs). The backend makes a new one, but older VMs keep the old key. Protect
top-level dotfiles when syncing a working tree into an install.

### 2026-08-04 — v2.8.2 (adm241) — the upgrade stream cut-off

Reported from another host: the dashboard upgrade truncated its output right after `npm ci`, and a
retry sat on "Backend restarted. Waiting for new version…" indefinitely.

**Root cause, measured not guessed.** The endpoint polled the transient unit with
`systemctl is-active` and treated a non-zero exit as "finished". Verified on the host: a running
`Type=oneshot` unit reports `ActiveState=activating` and `is-active` **exits 3**, while
`ExecMainStatus` is still 0. So the first poll — two seconds in — declared the upgrade complete,
emitted `done: 0`, and killed the journal tail mid-build. The dashboard then began waiting for a new
version before the build had started, and gave up 90s later.

Both reported symptoms were this single bug. The upgrade itself ran correctly throughout.

**Reproduced and fixed, back to back on the same host.**

| | stream duration | what it showed |
|---|---|---|
| v2.8.1 (bug) | **3 s**, then `done: 0` | cut off as the build began |
| v2.8.2 (fix) | **28 s** | npm ci, both builds, vite transform, chunks — ending only at the genuine restart |

Afterwards: 2.8.2 running, all services active, VMs untouched, no errors.

The same faulty probe also guarded "is an upgrade already running", so a retry could try to start a
unit that already existed. Covered now by a unit test on the state classification.

### 2026-08-03 — v2.8.0 (adm241) — verification, alerting, metrics retention, CI

Deployed onto the same host, upgraded in place from 2.7.1.

**Verified**

- Migration 5 applied on boot; `vm_metrics_hourly` and `system_metrics_hourly` present,
  `user_version` = 5.
- **Metrics rollup, both directions.** Ran the sampler's own rollup SQL and got three hourly rows
  with correct averages; `7d` and `30d` then returned exactly those points, per-VM as well as
  host-wide. An unrecognised range falls back to `1h` rather than erroring.
- **Backup verification on a real chain**: walked a two-link chain (full + incremental), checked
  both images, reported ok, and persisted the result into the backup listing.
- **Verification failure, proved by breaking a real backup.** Overwrote 8 KB in the middle of a full
  backup's qcow2; verify returned `ok: false` carrying qemu-img's actual complaint
  ("refcount table entry 5331 has reserved bits set"), and the alerts endpoint raised a
  `verify-failed` error against that VM. Restoring the good image cleared both.
- **Scheduled-failure alerting, end to end.** Gave a non-existent VM an hourly schedule due five
  minutes ago and let the real scheduler tick: it attempted the backup, failed, wrote
  `lastRunStatus: error` with the underlying message onto the schedule, and the alert surfaced it.
  Deleting the schedule cleared it.
- **Chain-broken alerting**: moving a full backup out from under its incremental raised the alert;
  putting it back cleared it.
- 157 unit tests, `shellcheck` at default severity, and the version-consistency check all pass
  locally and are wired into CI.

**Found by the new tests, fixed before release**

- `deriveDomainXml` carried the source's cached `<backingStore>` into a clone or restored VM. The
  copy's disks are standalone, so the new VM described a chain its files did not have — the same
  stale-cache condition that makes qemu refuse to open a disk outright.
- Firewall validation reported a bad value without saying which rule it came from.

**The update.sh hand-off, tested for real (v2.8.0 → v2.8.1)**

The host was put cleanly on 2.8.0 — so the `update.sh` on disk had the hand-off but not yet the
`-f` fix, exactly what a real 2.8.0 install looks like — and 2.8.1 was published. The dashboard
upgrade then produced:

```
[✓] Updated ad4e805 → bde4acb
[→] Handing off to the updated update.sh…
[→] Building VirtPilot...
[✓] Build complete
[✓] VirtPilot restarted successfully
```

The hand-off fired exactly once (no loop), the second pass rebuilt rather than taking the
"already up to date" exit, and git, `package.json`, `dist/.version`, the API and the built bundle
all landed on 2.8.1 together. Running VMs were untouched.

**A bug this test found — fixed in 2.8.1**

Staging it surfaced something real. `update.sh` switched the working tree onto `origin/main`
*before* hard-resetting, and that switch refuses whenever a tracked file has local modifications —
which is precisely the drift the reset exists to clear, and `npm install` rewriting
`package-lock.json` is enough to cause it. Worse, the failure was silent: output went to
`/dev/null` and `set -e` exited without a word, so the dashboard's update simply stopped after
"Pulling latest changes…". The checkout is now forced and a genuine failure reports itself.

**Not exercised**

- The `schedule-overdue` alert: it only fires when the scheduler *isn't* running, which cannot be
  staged without stopping the service mid-test.

### 2026-08-03 — v2.7.0 (adm241 / 62.238.37.117, clean Ubuntu 24.04) — IN PROGRESS

Full-product pass on a **fresh install**: real `bootstrap.sh` one-liner, then 2.7.0 overlaid.
Host has **no nested virtualisation** (`kvm_amd` won't load), so guests run under TCG software
emulation — everything works, boots are just slow. Single /32 IP and no pre-existing bridge, so
only the managed NAT network is exercised; bridged/existing-bridge networking is untested here.

**Bugs found and fixed**

- **(fixed) `install.sh` executed its own comments as root.** The systemd-unit heredoc is unquoted
  (it has to expand `${INSTALL_DIR}`), and two comment lines contained backticks. Every install ran
  `unable to change to root gid`, `apt upgrade` and `sudo systemd-run` as root, printed three
  confusing errors, and wrote a unit file with the comments blanked out. Backticks removed and a
  warning left in place. `apt upgrade` aborted at its prompt, so no package was actually touched.
- **(fixed) Backing up a VM with an active snapshot recorded the overlay's filename.** The backup
  image was named `<vm>-vda-snap1.qcow2` instead of `disk.qcow2`, so restoring it later wrote a
  stray file beside the real disk and the VM carried on booting the untouched original — a restore
  that reported success and changed nothing. Backups now resolve the VM's own disk by walking the
  backing chain to the first link VirtPilot tracks in `vm_disk_locations` (which stops one link
  short of the shared template). Restore additionally refuses when the VM is booting from an
  overlay, rather than writing a file nothing will read.
- **(fixed) A backup permanently disabled snapshots for that VM.** 2.7.0 created a checkpoint on
  *every* backup of a running VM. A checkpoint pins a dirty bitmap inside the qcow2, and libvirt
  then refuses **all** block operations — `snapshot-create`, `blockcommit`, revert — with
  "cannot perform block operations while checkpoint exists". Checkpoints are now only created when
  incrementals are actually opted into (`kind: incremental`/`auto`, i.e. the Incremental button or
  an incremental-mode schedule). A plain full backup leaves no checkpoint and snapshots keep
  working. Snapshot creation also now fails with an explanatory message instead of raw virsh output.
- **(fixed) Restoring over a VM that had checkpoints left it unbootable.** Replacing the image
  invalidates the bitmaps libvirt still believes in; the checkpoint then cannot be deleted and qemu
  refuses to open the disk ("Failed to get write lock"). Restore now clears the VM's checkpoints
  *before* touching the images, while libvirt can still remove them cleanly.
- **(fixed) Malformed request bodies returned 500.** A multipart upload posted with a JSON
  content-type — or any truncated body — reached the global error handler as an "Unhandled error"
  stack and a 500. body-parser failures are now 400 (413 for oversize).
- **(fixed) Un-ticking a storage directory's "default" checkbox silently did nothing.** The server
  only ever moves a default, never clears one (correct — every purpose must always have exactly one),
  but the dialog let you untick it and reported success. The checkbox is now disabled with an
  explanation once the directory holds the flag.

**Verified on the clean install**

- `bootstrap.sh` → `install.sh` end to end: apt deps, Node 20, libvirtd, storage tree, nginx on
  :3001 with a self-signed cert, backend on 127.0.0.1:3002, sudoers, systemd unit, default NAT
  network `myNet` (10.0.1.0/24, bridge `vp0`). Re-running `install.sh` preserved the password hash
  and `JWT_SECRET`.
- Auth: unauthenticated API 401, wrong password 401.
- Storage dirs: seeded default, add, all eight invalid paths rejected with accurate messages,
  `$`-in-path accepted, default shifting, delete.
- Templates/ISOs: URL download, multipart upload, rename (meta.json), move between dirs.
  **SSRF guard rejected all six vectors** — link-local, loopback, IPv4-mapped IPv6, RFC1918,
  `file://`, and `localhost`.
- VM lifecycle under TCG: create from template (UEFI + NVRAM), start, cloud-init applied hostname
  and SSH key, DHCP lease from the managed NAT network, **guest reached the internet through NAT**,
  add second disk, resize vda 2→3 GB, `vm_disk_locations` rows correct.
- Port forward: created with a DHCP reservation, DNAT rule correctly scoped to `-i eth0`, matching
  FORWARD ACCEPT rule.
- Backups on a clean install: full 198 MB, **incremental 403 KB**, chain metadata correct,
  checkpoints created, `crash-consistent` correctly reported (Alpine has no guest agent).
- Restore over the VM, restore-into-a-new-VM, and clone all succeeded.

**Bugs found and fixed (continued)**

- **(fixed) A restore left the VM unbootable via a stale backing chain.** libvirt caches each disk's
  chain in `<backingStore>` inside the persistent XML. Replacing an image out-of-band leaves that
  cache describing a chain the file no longer has — on the test VM, *vda*'s cached backing pointed
  at *vdb*'s image, so qemu opened that file twice and refused to start the domain with
  `Failed to get "write" lock`. Restore now strips the cached chain and re-defines, so libvirt
  re-probes from the images.
- **(fixed) A deny-all firewall locked the operator out of their own firewall.** Applying rules
  resolved the VM's IP from its static allocation or the host ARP cache. A VM on a managed NAT
  network has no static allocation, and a deny-all inbound policy is precisely what stops ARP
  resolving — so the next apply, including the one undoing the policy, failed with "Could not
  resolve VM IP". Resolution now also consults libvirt's DHCP leases, which are unaffected by guest
  reachability. Verified by flushing the host ARP cache under a deny-all policy: apply still succeeds.
- **(fixed) Status codes.** Snapshot creation blocked by checkpoints returned 500 (now 409);
  deleting a template or ISO that does not exist returned 500 (now 404).

**Verified (continued)**

- **Full clean-slate regression on a fresh VM**, end to end: full backup leaves no checkpoint →
  snapshot create and delete both work → requesting an incremental opts in to a checkpoint and takes
  a full with an explanatory note → the next run is a true incremental (861 KB) → snapshot is now
  refused with the explanatory message → restore clears the checkpoints, refreshes the backing chain
  and the VM **boots** → and the guest proves the rollback: the marker written before the backup is
  present, the one written after it is gone.
- Section 6: a VM created on a non-default storage dir puts its disk on that mount while NVRAM,
  `name.txt` and the cloud-init seed stay on the system root — and it boots from the non-default mount.
- Section 7: moving a VM disk is refused while the VM runs (409), and the three-phase move relocates
  the file, rewrites the domain XML, updates `vm_disk_locations`, cleans up the source folder, and
  the VM starts from its new home.
- Section 8: missing-file detection flags `fileMissing`, start fails with a clear libvirt error, and
  the flag clears when the file returns.
- Firewall chains are created and torn down correctly; NIC bandwidth shaping applies and produces an
  htb qdisc.
- Section 12 negative tests: duplicate VM name 409, invalid name 400, no networks 400, malformed
  UUID 400, deleting a storage dir still holding disks 400 (with the disk count), traversal in a
  backup id 404.
- Activity log recorded 61 entries across 18 event types; the metrics DB held 18 per-VM and 122
  host samples; 9 host devices enumerated; APT reported 71 upgradable packages.
- **2FA, full lifecycle**: enrolment returns a secret and a QR data URL; enabling makes login return
  `requiresTotp` with a `tempToken` and no session token; a wrong code is refused; a correct code
  issues a working session token; **replaying that code is refused**; a forged `tempToken` is
  refused; and a *session* token cannot be passed off as a `tempToken` (the `pending2fa` claim is
  checked). Disabling restores password-only login.
- **WebSocket upgrade auth** on `/ws/console`, `/ws/ssh` and `/ws/vnc`: 101 with the token in
  `Sec-WebSocket-Protocol`, **401 with no token, and 401 for a token in the query string** — the 2.6
  hardening holds on all three endpoints.

**Bugs found and fixed (continued)**

- **(fixed) Port forwarding never worked on a managed NAT network.** The DNAT rule was correct and
  counted hits, but the companion `FORWARD ... -j ACCEPT` was **appended**, landing below libvirt's
  own jumps — and the chain they lead to ends with
  `-o <bridge> -j REJECT --reject-with icmp-port-unreachable`. The packet was rejected before our
  ACCEPT was ever consulted, so an external client got "connection refused" while the DNAT counter
  ticked up. The rule is now **inserted** at the head of FORWARD. Verified from an external client:
  before the fix, connection refused; after, the connection reaches the guest's sshd.
- **(fixed) A snapshot taken while the VM was stopped could never be deleted.** libvirt only applies
  dynamic ownership when there is a qemu process to label for, so an overlay created for a shut-off
  domain keeps `root:root 0600` — which the service account cannot chmod. Deleting the snapshot then
  runs `qemu-img commit` as `libvirt-qemu` and fails with "Permission denied", leaving an
  undeletable snapshot and a VM permanently running off the overlay. Overlays are now pre-created by
  the service at 0660 and handed to libvirt with `--reuse-external` (the same approach as the backup
  targets), and a failed snapshot cleans up the files it made.
- **(fixed) Invalid firewall rules were accepted at save time.** A rule with an out-of-range port
  saved with 200 and only failed later at apply, after the operator had left the page believing it
  was in force. Rule sets are now validated on save and rejected with a 400 naming the offending
  rule.

**Verified (continued)**

- **Port forward end to end from an external client**, after deleting and recreating the forward
  through the API so the fix was genuinely exercised.
- **Offline snapshot create + delete**: the overlay is `virtpilot:virtpilot 0660`, the delete commits
  it away, the domain returns to its base disk, the overlay file is removed and the VM starts.
- VM operations: autostart on/off, boot-order read and write, CD-ROM attach and detach, CPU/RAM edit
  (correctly refused while running, applied when stopped), and rename — which updates the domain,
  `name.txt` and the metadata record, and renames back cleanly.
- Firewall validation: out-of-range port, reversed range, ports on ICMP, bad direction, bad action,
  malformed source CIDR and an invalid default policy are all rejected with 400 and a specific
  message; a valid rule set saves, applies and installs its chains.
- Activity log clearing (84 entries → 0); `maxLogs` clamps to its 10–10,000 bounds.
- The IP allowlist round-trips, and **refuses an allowlist that would exclude the caller's own IP**
  rather than locking the operator out.

- **(fixed) The firewall and port forwarding fought over FORWARD, and the winner depended on the
  order you configured them in.** Both insert at the head of the chain, so configuring the firewall
  first left a later port forward sitting *above* it — quietly punching a hole through a deny-all
  inbound policy — while configuring the forward first let the firewall shadow it. Measured both
  ways: identical settings, opposite security outcomes. The per-VM firewall is the policy and a port
  forward is only address translation, so the firewall now always wins: adding a forward re-asserts
  the VM's firewall jumps at the head. Verified that both orders now produce identical rule ordering,
  that a deny-all policy blocks a forwarded port, and that adding an explicit allow rule for the
  forwarded port makes it reachable from an external client again.

**Verified (final)**

- **All three WebSocket endpoints driven for real**, not just handshaked: `/ws/console` returned the
  guest's serial login prompt through `virsh console`, `/ws/ssh` gave an interactive shell where
  `hostname; id` ran inside the guest, and `/ws/vnc` returned qemu's `RFB 003.008` banner.
- All nine starter template-set URLs return 200 — no repeat of the dead-mirror problem that shipped
  in an earlier release.
- Host devices enumerate (7 PCI, 2 USB).

**Final end-to-end regression on a fresh VM**, run after all thirteen fixes were in place: create from
template → boot under TCG with cloud-init → snapshot create and delete → full backup (named
`disk.qcow2`, no checkpoint left behind) → incremental chain → clone → restore-into-a-new-VM →
restore over the original. The rollback was proved with a marker file: written *before* the backup,
changed *after* it, and back to its original contents once the VM restarted. `<backingStore>` count
after the restore: 0.

**Measured, not assumed**: `GET /api/vms` with two running guests returns in **0.55 s** — an earlier
suspicion that its per-VM `virsh` fan-out was a bottleneck did not survive measurement. A transient
`000` from nginx during a heavy multi-guest phase did not recur across repeated probes and left
nothing in either nginx's or the service's log.

**Section 13 — self-upgrade (run after v2.7.0 and v2.7.1 were published)**

Both upgrades were driven through `GET /api/system/upgrade`, the SSE endpoint the dashboard's
**Update** button calls, with the JWT in the `Authorization` header.

- **2.6.1 → 2.7.0**, the path a real existing install takes. The clone was reset to `v2.6.1` and
  rebuilt first so the upgrade ran the *previous* version's `update.sh` — which is what actually
  happens, and the reason a migration can never cover its own release. It recovered from the
  detached HEAD `bootstrap.sh` leaves behind ("switching back to main"), pulled a6b0ff0 → 9cf6483,
  verified apt packages, ran `npm ci`, rebuilt both packages and restarted the service. Version,
  `dist/.version` and the sidebar string in the built bundle all moved to 2.7.0 together, and the
  update card went to `updateAvailable: false`.
- **2.7.0 → 2.7.1** likewise.
- **Running VMs were untouched**: the qemu process kept its original start time straight through,
  and the guest's serial console still answered afterwards. The service restarts, the guests do not.
- **Operator state survived**: login worked immediately (JWT secret and password hash preserved),
  and VMs, networks, templates, storage directories and backups were all intact. The upgrade is
  recorded in the activity log as `system.virtpilot.upgrade`.
- The SSE stream ended early. At the time this was put down to the service restart closing it;
  that was wrong, and the real cause was found later — see the 2.8.2 entry.

**One fragility found while rolling the host between versions (fixed in 2.7.1)**

Rolling back with `git reset --hard` leaves untracked files behind, so a `git clean -fd` is the
natural follow-up — and that deleted `/usr/local/virtpilot/.ssh/`, the keypair VirtPilot injects
into every VM it builds. The backend silently generates a new one, so new VMs keep working while
every VM created earlier keeps the old key in its `authorized_keys` and can never be reached from
the SSH tab again; only the serial console gets you back in. Nothing VirtPilot ships runs
`git clean` (`update.sh` uses `git reset --hard`), so no install can have hit this unaided — but
the keypair is now git-ignored, which is enough for `git clean -fd` to spare it. Verified: after
the fix `git clean -nd` no longer lists it, and the key survived the 2.7.1 upgrade unchanged.

**Not testable on this host (environmental, not defects)**

- **Host-device passthrough** — the box is itself a VM with no IOMMU groups, so VFIO cannot bind.
- **Bridged and existing-bridge networking** — a single /32 public IP and no second NIC. Only the
  managed NAT network was exercised.
- **Nested guests run under TCG**, so nothing here says anything about KVM-accelerated performance.
(Section 13, the self-upgrade, was blocked at first for want of a published release and is
covered above now that v2.7.0 and v2.7.1 exist.)
- Saving a firewall rule with an out-of-range port (`portRange: "99999"`) is accepted with 200;
  validation only happens at apply time, so an invalid rule can be persisted and fail later.
- Snapshot deletion against a *stopped* VM failed once with a truncated `qemu-img commit` error;
  the running-VM path (blockcommit) works.
- Section 13 (in-dashboard self-upgrade) needs a published release newer than the installed build.

### 2026-08-03 — v2.7.0 (slc-gateway, isolated instance)

Sections 14–17 run against a throwaway Debian 13 guest (UEFI, static IP, guest
agent installed) on a second VirtPilot instance with its own `STORAGE_ROOT` and
port. The production install on the same host was untouched throughout.

**Method note.** Do not point a second backend at a shared host without first
checking `port-forwards.json`. `portForwardService.applyAllRules()` strips
*every* `virtpilot-`-tagged nat PREROUTING rule at boot and re-adds only those in
its own storage root — a second instance would silently delete the first's port
forwards. This host had none, so the QA instance was safe.

**Bugs found and fixed in this release**

- **(fixed) libvirt push-mode backups produced images nothing could read back.**
  A target file libvirt creates itself has no previous owner to remember, so the
  security manager labels it `root:root 0600` when the job releases it. The
  backup reported success, then every later `qemu-img` call — the rebase that
  chains an incremental, the convert that flattens a chain on restore — failed
  with "Permission denied". Both incremental backups *and* restores of any
  push-mode backup were broken. Targets are now pre-created by the service at
  mode 0660 and handed to `backup-begin --reuse-external`, which also lets the
  incremental's backing pointer be set at creation rather than patched in after.
- **(fixed) A restore refused for a legible reason returned HTTP 500.** Broken
  chain, VM still running, name already taken and corrupt backup all reported as
  server faults. They are 4xx now (409/422/400), which is what the dashboard
  needs to tell the operator what to do.
- **(fixed) `virsh undefine` was not asked to drop checkpoint metadata.** Deleting
  a VM that had been backed up incrementally worked in the default path only
  because removing its storage takes the checkpoints with it; a "keep the
  storage" delete could be refused. `--checkpoints-metadata` is now passed, with
  a fallback for libvirt older than 5.6.

**Verified**

- Freeze window: **0.074 s** maximum guest stall across an 8 s backup that copied
  1.4 GB, measured with a 10 Hz clock loop inside the guest doing continuous
  writes. Pre-2.7 this gap was the whole copy duration. Regression guard for 15.1.
- Incremental really is a delta: 4.1 MB against a 1.4 GB full, with
  `backing file: ../<parent-id>/disk.qcow2` — relative, so the tree is relocatable.
- **Chain integrity, end to end.** A 3-link chain (full → inc → inc) restored into
  a new VM produced a guest containing all three generation markers *and* exact
  md5 matches for a 200 MB and a 30 MB random payload written at different points
  in the chain. The restored disk is standalone.
- Restore-as-new after the source VM was **deleted outright** rebuilt a working
  machine, new UUID/MAC/NVRAM/VNC port, fresh IP (10.0.0.3 while the source kept
  10.0.0.2), warning returned naming both.
- Clone of a running VM: `app-consistent`, standalone disk, zero references to
  the source UUID in the clone's XML, source's checkpoint list unchanged, second
  concurrent clone refused with 409. Clone keeps a shared ISO on `sdb` and gets
  its own cloud-init seed.
- Fallbacks all take a full backup and say why rather than failing: no parent yet,
  VM stopped (`offline-convert`), guest agent stopped (`crash-consistent`).
- Chain safety: deleting a parent → 409 with `requiresCascade` and the dependents
  listed; `?cascade=true` removes the subtree; retention kept an expired full that
  still had a live incremental on it; a hand-deleted full marked its descendants
  `chainBroken` and their restore was refused rather than producing a corrupt disk;
  a stale checkpoint whose backup directory was removed was swept on the next run.
- Compression: 636 MB vs 1.4 GB uncompressed, still via `libvirt-backup`.
- Overwrite restore rolled the guest back correctly — a file written after the
  backup was gone, files inside it present.
- Name collisions on both clone and restore-as-new left no orphaned disks.
- Zero stack traces in the service journal across the entire run.

**Not covered**

- Multi-disk VMs (extra `vdb`) through the incremental path — single-disk only.
- Backups to a `BACKUP_ROOT` on a separate filesystem or NFS mount.
- A host where `domcapabilities` reports `<backup supported='no'/>`, so the
  `snapshot-convert` tier (2) was never exercised on real hardware; only its
  building blocks (external snapshot + blockcommit) are shared with the existing
  snapshot code, which this host does exercise.
- Schedules firing on their own timer — the scheduler path was tested by calling
  `createBackup` with the same options the scheduler passes, not by waiting.

### 2026-05-05 — v2.3.0 (62.238.0.136, clean install)

Full pass with the following findings. Bugs marked **(fixed)** were patched into v2.3.1 in the same commit as this entry.

**Bugs**
- **(fixed) `getVmDisks` couldn't populate `storageDirId`/`storageDirName` when called with a UUID.** [vmService.ts](packages/backend/src/services/vmService.ts:181) called `virsh domuuid <name>` to resolve UUID → location lookup, but every public API path passes the UUID directly, not the libvirt name. `virsh domuuid` errors on UUIDs ("failed to get domain"), the catch swallowed it, and the disk-locations map ended up empty. Visible consequence: the Move button on the VmDetail Disks tab never appeared (its render-gate is `d.storageDirId`). Fix: detect a UUID-shaped input and skip the virsh round-trip. Verified after hot-patch — vda/vdb now show their storage dir name in `/api/vms/:uuid` response.
- **(fixed) Move-to-wrong-purpose returned HTTP 500.** Templates `/move` and ISOs `/move` routes had a single catch-all that funnelled every error to 500. ValidationError → 4xx now, matching the `/api/storage/dirs` route's pattern.

**Footguns / docs gaps**
- `/tmp` and `/var/tmp` aren't rejected by `assertPathSafe`. Registering one works; `/tmp` survives until next boot, then disappears. Consider adding to FORBIDDEN_PARENTS or a follow-up "well-known ephemeral location" warning at create time.
- A relative path like `relative/path` is rejected with "cannot be inside the VirtPilot install directory" instead of "must be absolute". `path.resolve` runs the input through `process.cwd()` (the install dir) before `assertPathSafe` sees it, so the normalised path lands inside the install dir. Functionally correct but the error message hides the real reason. Worth a one-line tightening.
- Path-traversal via `..` is *technically* rejected — `path.resolve` normalises before the safety check, so `..` always resolves to a real path that may or may not exist. The explicit `if (norm.includes('..'))` check is dead code. Not a vuln but the comment lies.

**Out of scope for this run**
- Cross-filesystem move (7.8) — needs a second physical mount or a tmpfs-backed bind mount; deferred until the test environment offers one.
- Self-upgrade (Section 13) — only meaningful when there's a newer release tag.
- Port-forward exercise — happy-path NAT verified; full forward-rule walk left for the next run.

**Changelog notes**
- The default storage dir's `templates/` and `isos/` subdirs are mode 0755 (inherited from `install.sh`'s `mkdir -p`); other dirs registered later get 0770 (set by `ensurePurposeSubdirs`). Both work — libvirt-qemu only needs read for templates/isos. Inconsistency is benign but worth a sentence in the docs.
