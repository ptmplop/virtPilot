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
19. [VXLAN networks](#19-vxlan-networks) — IDs, addressing, isolation, MTU, VLANs in the guest, remote hosts, firewall, reboot
20. [Managed bridges](#20-managed-bridges) — back after a reboot, the NIC and when it is refused, upgrade from a plain bridge, repair, delete

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

Delete a NAT network with a VM on it, running or stopped: the dialog names the VMs and Delete waits, and the API says 409 naming them. Add a NIC on another NAT network to a VM while its delete dialog is open: the dialog notices within 5 seconds, and frees Delete again when the NIC goes. With no VM on it: the network, its bridge and its firewall rules go. A DHCP OS bridge's record deletes with VMs on it, and they keep running; one with a static pool is refused while addresses are allocated.

A VM attached with `virsh attach-interface <vm> network virtpilot-<id> --config` counts as connected, and its Network tab can remove the NIC.

A port forward on a NAT NIC, then remove the NIC: the DNAT rule (`iptables -t nat -S PREROUTING`), the record, the host port and the locked address (`virsh net-dumpxml`) all go. Remove a NIC with `virsh detach-interface` instead, leaving its forward stranded as older versions did: deleting the network clears it, rule and all.

The NAT and bridge table fits at 1024 px with the sidebar open (`scrollWidth` of the table against its box, 702 px): a static pool of 65024, a 15-character gateway, a 15-character NIC name with no link (`enx00e04c680001`, how a USB NIC is called), a long network name. Delete is in view on every row. For the VXLAN table, see section 19.

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

## 19. VXLAN networks

Needs VT-x or AMD-V for speed, and a second machine on the internet for the tunnel checks. The second machine doesn't need VirtPilot: a VTEP in a network namespace is enough. Use a real public address on the host under test, because whether strangers can reach the VXLAN is part of the test. Testing from the host itself proves nothing.

**The ID.**

1. New network, VXLAN, Next available: gets 100. The next one gets 101. Delete both: back to 100.
2. Choose 5000: created. Choose 5000 again: 409 naming the network. 0, 16777216, 1.5 and `abc`: 400. 1 and 16777215: created.
3. `ip link add foreign9 type vxlan id 9000 dstport 4789`: 9000 is refused naming `foreign9`, and shows as used in the form before Create. An ID equal to the next available one is skipped.
4. Five creates at once: five different IDs, all recorded.
5. `ip -d link show type vxlan` shows each `vpx<ID>` with its ID, on bridge `vpbr<ID>`, and `state DOWN`.

**VMs on it.** Create two VMs from a template with NAT (primary) and a DHCP VXLAN ticked, and one with only the VXLAN.

6. Both NAT VMs get a VXLAN address. `ip route` in the guest: the default route is on the NAT NIC only. DNS and internet still work. `resolvectl dns eth1` is empty.
7. `cat /sys/class/net/eth1/mtu` in the guest is 1442 with nothing configured. `ping -M do -s 1414` to the other VM works, and 1415 is refused by the guest.
8. The VXLAN-only VM reaches the others and has no default route and no internet.
9. A VM on another VXLAN can't reach this one, and a NAT VM can't route into it through the host.
10. `ss -uln | grep 4789` is empty and `iptables -S | grep VP-VXLAN` is empty.
11. A static pool: each VM has the address chosen in the wizard. None mode: a VM boots without waiting for DHCP.
12. Connect a VM (running): the NIC appears at once with the MTU, and is kept for next boot. On a stopped VM: saved, and it starts with it. Clone a VM on a static pool: the clone gets a new address and keeps the MTU.
13. Delete a VXLAN with VMs on it: the dialog names them and Delete waits, and the API says 409 naming them.
14. The Overview's address and the SSH console use the primary NIC's address; a VM only on a VXLAN shows its lease. A stopped VM shows no address. Firewall Apply on a VM with NAT + VXLAN: `iptables -S FORWARD` has the NAT address and never the VXLAN one. On a VM only on VXLANs: 409 with the reason, no FORWARD jump, and a NAT VM still can't route into the VXLAN.
15. A create that fails late (a bad hostname) gives its static address back. A rate limit that is refused adds no NIC and keeps no address.

**VLANs in the guest.** Between two VMs on one VXLAN, with `ip link add link eth1 name eth1.10 type vlan id 10` and for QinQ `ip link add link eth1 name eth1.100 type vlan proto 802.1ad id 100`, then `ip link add link eth1.100 name eth1.100.200 type vlan id 200`.

16. 802.1Q, 802.1ad + 802.1Q and 802.1Q + 802.1Q: each passes `ping -M do -s 1414` at the MTU the VLAN interface inherits, and iperf3 flows.
17. `tcpdump -enni vpbr<ID>` (no filter: the kernel holds the outer tag as metadata, where a filter on `ether proto 0x88a8` never sees it) shows the tags as the guest sent them.
18. VLAN 31 on one VM and VLAN 32 on the other, same subnet: no traffic. Same outer tag with different inner tags: no traffic. The same VLAN ID on another VXLAN: no traffic. Give each VM only its own side: a VM holding both answers ARP across them, and proves nothing.
19. The same on an e1000e NIC, and on a NIC added to a running VM.

**Remote hosts.** Send crafted frames from the other machine (a UDP datagram to port 4789: `08 00 00 00`, the 3-byte ID, `00`, then an Ethernet frame) and watch `tcpdump -ni vpbr<ID>`.

20. No remote hosts: not delivered. A remote host listed that isn't the sender: socket open, `-A INPUT -p udp -j VP-VXLAN` first in INPUT, still not delivered. The sender listed: delivered. The sender listed on another VXLAN only: not delivered on this one.
21. On the other machine, a VTEP with the same ID and MTU: ping both ways, at full size with `-M do`, with no tag, one tag and QinQ. iperf3 flows. Capture `udp port 4789` on the host's own NIC: no fragments, nothing over 1500 bytes, source address is the routed one. The panel shows machines seen behind the remote host, and the Remote hosts dialog shows bytes.
22. Delete the INPUT jump, flush the chain, restore a stale chain of the same size, `ip link set vpx<ID> nomaster`, delete the flood entry, delete the device: each is put right within 35 seconds, and traffic flows. `virsh net-destroy` its libvirt network: the bridge is back within 35 seconds, and running VMs are back on it.
23. Fail closed: remove the chain and make the `xt_u32` module unavailable. Within 35 seconds the tunnel is down and nothing listens; the panel says why; changing remote hosts is refused and the record is unchanged. Put the module back: up again and the problem clears.
24. `systemctl restart virtpilot`: rule count unchanged, one flood entry, traffic still flows.
25. `ufw --force enable` with default deny: the remote host still passes. `modprobe br_netfilter`, `bridge-nf-call-iptables=1`, FORWARD policy DROP (a host running Docker): VMs still reach each other, across the tunnel too, tagged too.
26. Remote hosts emptied: device down, no socket, no rule, chain or jump, no flood entry; VMs on this host unaffected.
27. Another UDP port: listens there, the rule follows it, gone on delete.

**Reboot.** Two VMs on autostart, a remote host listed, then reboot.

28. With nobody touching it: VMs running, devices back on their bridges in the right state, flood entry, rules and jump in place, VMs reach each other at full size, the tunnel works, and a VM left off starts on its VXLAN.

**Attached outside VirtPilot.** Attach a VM by the network's name, not its bridge: `virsh attach-interface <VM> network virtpilot-<id> --config`.

29. Stopped, or running with the NIC defined before it started: it is in the panel's Connected VMs with its lease, and Connect a VM no longer offers it. Its Network tab names the network and its type, and Add NIC doesn't offer that network again. `GET /api/vms/<uuid>`: `source` is `vpbr<ID>`, and `type` is `network`.
30. `ip link delete vpbr<ID>` with it running: within 35 seconds the bridge is back with its tap on it, and it reaches the others again. With it stopped: Power on brings the bridge back, and it starts.
31. A VM only on a VXLAN by name: the Firewall tab says the rules don't apply, and Apply gets a 409.
32. Remove NIC names the network, and `virsh domiflist` no longer lists it. On a NAT network by name, its Port forwards section is there. A libvirt network VirtPilot doesn't know, such as `default`, shows under its own name. A static network with nothing allocated says "Set inside the VM".
33. On a running VM, `--config` as above: the NIC shows only under `virsh domiflist --inactive`. The panel says "From its next start", its Network tab row says "from its next start" and "Not connected yet", and Reboot doesn't change that: only a shutdown and start does. The delete is refused naming the VM, a rate limit goes in, and Remove NIC says the running VM isn't touched, then takes it off the saved definition with no error.
34. On a running VM, with no flags and `--model virtio`: the NIC shows only in the live listing, marked "until its next start". The delete is refused. A rate limit goes in and reads back. A port forward and Lock IP are refused, and the Port forwards section isn't there. Remove NIC takes it off once the guest answers, with the saved definition untouched.
35. Start with its network stopped or undefined: a network of VirtPilot's names its bridge and the Networks page; one it doesn't know says `virsh net-start`, or that it no longer exists. Neither shows `Command failed`.
36. A VM only on a VXLAN by name, with chains `VP-IN-<id>` and `VP-OUT-<id>` left from before and FORWARD jumps to them: Firewall Apply gets a 409 saying none are in force, and the chains and jumps are gone. With a NAT NIC saved for its next start: still a 409, and they stay.
37. With `virsh edit` on a running VM, move a NIC's saved copy to another network: two rows with one MAC, the VM on both networks' lists, and neither network can be deleted. Remove NIC names both and takes both. On a libvirt network with `<forward mode='bridge'/>`, a running VM's `domiflist` says `bridge` and `--inactive` says `network`: one row, unmarked, and Remove NIC takes it from both.
38. A VM with a NAT NIC under deny-all, with a forward added on a second NAT NIC: `iptables -S FORWARD` still has its jumps on the first NIC's address, above the forward's ACCEPT. The same after `systemctl restart virtpilot`. A forward on the first NIC whose reservation gives it a new address: the jumps go to that address.
39. A port forward on a NIC with no address, with another VM holding the network's lowest address by lease: the forward takes the next address. On a NIC moved here for its next start, with ARP still naming its address on the old network: the forward gets an address on this one.
40. Clone a running VM with a NIC saved for its next start and another plugged in until then: the clone has the saved one with a new MAC, and not the other. Suspend a VM and `ip link delete vpbr<ID>`: its tap goes back on the bridge. `virsh define` a VM with a space in its name on a network: the delete is refused naming it.

**Width.**

41. At 1024 with the sidebar open, the table's `scrollWidth` is at most 702 with the longest values allowed: ID 16777215, VM and network names of 63 characters with nowhere to break, a 15-character VM address and remote host, and a CIDR such as `192.168.100.128/25`. Names wrap, nothing is clipped, and Delete is in view. The same names on a VM's Network tab fit too, with a 15-character address and a rate limit, and stay inside every dialog they appear in: measure the text with a Range, since a long word overflows its paragraph without the paragraph's box growing.

**Uninstall.** `uninstall.sh`: no `vpx*`, no `vpbr*`, no `VP-VXLAN`, no `virtpilot-*` libvirt network.

---

## 20. Managed bridges

A reboot is the only test of the boot path: libvirt autostarts networks once per boot, so restarting it proves nothing. Needs a spare NIC. With no cable on one, a veth with its far end in a network namespace running a switch, `dnsmasq` and a gateway address serves as the NIC: the API takes any interface name, though the form only lists physical ones.

**Making one.** Bridge, with a spare NIC that is down.

1. `virsh net-list --all` shows its `virtpilot-*` network active with autostart. `virsh net-dumpxml`: no `<ip>`, no `<forward>`. `/sys/class/net/vp<N>/bridge/stp_state` is 0, `/proc/sys/net/ipv6/conf/vp<N>/disable_ipv6` is 1, no `dnsmasq` for it.
2. The NIC's `master` is `vp<N>` and it is up (`flags` bit 0). A VM on the bridge gets a lease from the DHCP server behind the NIC and reaches its gateway.
3. Refused with a 409 and nothing left behind (`ls /sys/class/net`, `virsh net-list --all` unchanged): a NIC with an IPv4 address, one with only a default route (`ip route add default dev X metric 9999`), one with only an IPv6 default route, one on another bridge (which it stays on), one another network has, one not on the host. A name that isn't one: 400.
4. A failure after the bridge exists (`physicalNic: "lo"`) reports the error, removes the network and bridge, keeps no record, and the next create gets the same `vp<N>`.

**After a reboot.** Bridges with and without a NIC, a VM set to start at boot on each. Name a NIC in netplan on one of them (`eno2: {dhcp4: false, optional: true}`): networkd takes a NIC it manages off its master when it configures it.

5. The bridge is there and its libvirt network active. Each NIC netplan doesn't name is on its bridge and up within 45 seconds, and the one it names within three minutes, with the page saying why meanwhile. `journalctl -u libvirtd -b` has no "Cannot get interface MTU". The Networks page shows no problems.
6. VMs set to start at boot are running, each has a lease from behind the NIC and reaches the gateway. VMs not set to start at boot stay off, as for any VM on this OS, and start when asked.
7. For the gap between a VM starting and its NIC being on the bridge, compare `starting up` in `/var/log/libvirt/qemu/<vm>.log` with `[bridge]` in `journalctl -u virtpilot -b`: a few seconds at most, and usually the NIC is first.

**Upgrading.** On the previous version: a bridge with a NIC, a floating one, and VMs running on both. Keep `ping -i 0.2` running from a VM to the gateway and to another VM on the floating bridge. In-dashboard upgrade.

8. Neither ping loses a packet. The bridge's `ifindex`, its ports and the VMs' uptime are unchanged. A NIC the previous version left down is now up: bring it up by hand first to measure the pings. The record has `libvirtName`. `virsh net-list --all` has its network inactive with autostart. `systemctl restart virtpilot`: nothing changes.
9. Delete one now: its plain bridge goes, its libvirt network goes, its NIC is free and down.
10. Reboot. Each one is now owned by libvirt: its network active, `stp_state` 0, and step 5 and 6 pass.
11. A host where the previous version lost the bridge in a reboot: upgrade alone brings it back with its NIC, and the VMs start.

**What is put back, within about 35 seconds, with VMs running and without restarting them.**

12. `ip link set <nic> nomaster`. `ip link set <nic> down`. Traffic passes again.
13. `ip link delete vp<N>`, with libvirt still saying active. `virsh net-destroy <name>`. `virsh net-destroy <name>; virsh net-start <name>`, which falls between two passes. The bridge, every running VM's tap and the NIC are back, and traffic passes. The same on a VXLAN's bridge: `ip link delete vpbr<ID>`.
14. Stop a VM, `virsh net-destroy <name>`, start the VM at once: it starts, with its bridge back. Another VM still running on that bridge is reconnected.

**What is never taken, within about 35 seconds.** After `ip link set <nic> nomaster` each time.

15. `ip addr add 192.0.2.7/32 dev <nic>`: it stays off, the Networks page says why, and the journal says so once, not every pass. `ip addr del`: back on. The same with the NIC on the bridge: the pass lets go of it, and the address works.
16. The same with `ip -6 addr add 2001:db8:77::7/64 dev <nic>`, `ip route add default dev <nic> metric 9999` and `ip -6 route add default dev <nic> metric 9999`.
17. `ip link set <nic> master other`: it stays there and the page says why. Delete the network: it stays on `other`, and stays up.
18. Delete the NIC (a veth): the page says it isn't on this host. Make it again: back on, and up.
19. A NIC netplan names (`networkctl reload` to apply; `.network` files aren't readable by the service, so this is judged by `ADMIN_STATE`). `dhcp4: true`, the DHCP server stopped: off the bridge at once, and the page says it is waiting. Start the server inside two minutes (networkd asks again at about 62 s and 126 s, so it can take that long to notice): the NIC gets the address and stays with the host. `dhcp4: false`, or nothing answering: on the bridge after two and a half minutes, and traffic passes. `networkctl reconfigure` then takes it off again, and it goes back, once. With `dhcp4: true` after the host has had a lease, stop the server and flush the address, as a cable pull would: still off after three minutes, with `nicClaimed` on the record. Take it out of netplan: back on.
20. A VLAN on the NIC with the host's address on it (`ip link add link <nic> name <nic>.100 type vlan id 100`), the parent on the bridge: deleting the network leaves the parent up, and the VLAN passes traffic. uninstall.sh the same.
21. A record of the old type `public` naming `br77`, put in `networks.json` with the service stopped: no libvirt network and no `br77` after the start, no row in `/api/networks/bridge/status`. It deletes, touching nothing.

**Deleting.**

22. With VMs on it: the dialog names them and Delete waits, and the API says 409 naming them. With none: the network and bridge go, no `iptables-save` line names the bridge, and the NIC is free and down.

**The rest.**

23. `uninstall.sh`: no managed bridge is left, including a plain one from before the upgrade, and a real NIC that was on one is free and down. An OS bridge is left alone, even one called `vp<N>` attached with Existing OS bridge: only bridges named by a `virtpilot-*` libvirt network go.
24. Host with no managed bridges: no `virsh` from this feature on the 30-second pass (`libvirtd --timeout 120` still idles out with no VMs running).
25. Docker's state, `bridge-nf-call-iptables=1` and FORWARD policy DROP: a libvirt-owned bridge still passes traffic between VMs. To undo it, set the sysctl back to 0 and **leave the module loaded**: `modprobe -r br_netfilter` also unloads `bridge`, which deletes every bridge on the host.

---

## Findings log

Append per-run findings here. Format: `### YYYY-MM-DD — vX.Y.Z (host)` then bullet list.

### 2026-11-01 — v2.16.5 (the local rig, then callisto3-test1)

Section 19's new checks on the local rig (libvirt 11.3, TCG guests): 131/131 through the API and the real pages, among them NICs by name, stopped and running, one in only the saved or only the live definition, a MAC on a different network in each, a libvirt network in bridge mode, a stale firewall, a forward on a second NIC, another VM's lease on the lowest address, a paused VM across a rebuilt bridge, and a VM with a space in its name. On the code before the fix the first version of that suite failed 26 of 48. Real 63-character names on the pages and dialogs they land on: 30/30, after 9 failures on the code before the fix. Section 11 again: 51/51. VXLAN table at 1024 with the longest values allowed, served by intercepting the API: 785/702 before, 702/702 after, 667 at its narrowest.

The release itself: a real in-app upgrade on callisto3-test1 (libvirt 10.0) from 2.16.4 in 43 s, with VMs running (not restarted, their uptime rose from 43056 to 43331 s across everything here). On the released build, with a KVM guest attached by name under the MAC cloud-init knows: a real lease and the network's MTU, full-size pings before and after `ip link delete vpbr<ID>`, removed while running with the guest answering, a NIC saved for the next start, one plugged in until then with its rate limit reading back, a clone of the running VM with one of each, and the firewall jumps staying put across a forward on another NIC and a backend restart: 69/70, the failure being a bad check, which posted a forward for a MAC on a different network. The check it was meant to be passed 6/6. Section 11's `t-nat.py`: 23/23. This server's real rows at 1024: NAT and bridge 702/702, VXLANs 702/702.

Found by three review passes and not by any test until then: a NIC saved with `--config` on a running VM passed the delete guard; `--persistent` half-succeeding on a one-sided NIC; a port forward moving the firewall off the NIC it filters (since 2.7.0), and my first fix for that leaving it behind when a reservation moved the same NIC; a forward landing on an address another VM holds by lease; a NIC on a libvirt network in bridge mode splitting into two rows; "next boot" promising what a reboot doesn't do. My first check of dialogs measured boxes and passed dialogs a screenshot showed were broken: measure text with a Range.

Not fixed: the API accepts a port forward for a MAC that isn't on that network, which is older, and the dashboard never offers it. An OS bridge's record whose bridge is owned by a libvirt network VirtPilot doesn't know: a VM on that network by name keeps the libvirt name on its Network tab, and Add NIC offers the bridge again. A guest on a static pool can hold an address the pool still offers, as VirtPilot can't see what a guest set itself. A VM in the moment of being created isn't seen by the delete guard yet.

### 2026-10-31 — v2.16.4 (the local rig, then callisto3-test1)

Section 11's new checks: 50/50 on the local rig (real libvirt, TCG VMs) through the API and the real dialog, among them a VM added while the dialog is open, a stranded port forward and a NIC attached by the network's name. Table widths with worst-case rows served by intercepting the API: NAT and bridge 987/702 before, fits after (679 minimum); VXLAN with ordinary rows fits, and 785/702 with an 8-digit ID, a long VM name and two remote hosts, which scrolls inside its panel with nothing clipped.

The release itself: a real in-app upgrade on callisto3-test1 from 2.16.3, with VMs running (not restarted). On the released build, 23/23: refused with a VM stopped or running, deleted with none and nothing left behind, an OS bridge's record deleted with a VM on it, which still starts. The dialog on a real network named its two VMs with Delete disabled, and both tables fit 702/702 at 1024.

Found by a reviewer and a design critic on the diff, not by any test until then: the dialog's own advice stranded a port forward, since removing a NIC left it behind with nothing to remove it by, and the network then couldn't be deleted. My "worst case" used a 13-character NIC name, though `enx` + MAC is 15. TanStack Query puts a failed query with no data back to pending on each poll, so `isLoading` alone keeps flipping: use `isLoading && !isFetched`. A disabled observer keeps the cache alive, so a dialog's answer needs `gcTime: 0`, or reopening shows the old one.

### 2026-10-31 — v2.16.3 (callisto3-test1, the same machine)

Section 20 in full on real interfaces, 8 VMs and 6 bridges at the largest. None of the spare NICs has a cable, so traffic went through veths into a network namespace holding a switch, `dnsmasq` and a gateway; `eno1`, `eno2` and `eno4` proved the attach and the flags on real devices.

The control first, on stock 2.16.0: a real reboot lost `vp2`, `vp3` and `vp4`, libvirt logged `Failed to autostart VM 'old-a': Cannot get interface MTU on 'vp2'` for both autostart VMs, and both NICs came back detached and down. It also showed a second bug: as created, the NIC was never up (`flags 0x1302`), so a VM on the bridge got no lease until `ip link set up` by hand.

- Upgrade alone on that broken host: 25/25, with leases through the NIC. Create and refusals: 31/31. Refused NICs (address, either family; default route, either family; another master; gone; old `public` record) and the hold and claim below: 59/59. Put back with VMs running: 31/31, among them `ip link del` and a restart between two passes, on a VXLAN too. Two real reboots on the fix with 6 bridges and 8 VMs: 23 + 23 each time, no complaint from libvirt.
- Boot race, real reboot: a network naming a NIC netplan now gives to the host by DHCP, with the server answering 60 s into the boot. Off the bridge throughout, the host got its address, `nicClaimed` was recorded, and the address worked (7/7).
- The NIC is on its bridge before the first VM has started: at 09:11:41, against 09:11:43 for the first `starting up`. The backend's first pass runs as soon as libvirt lets it start. A NIC netplan names waits 148 s (measured), by design.
- `networkctl reconfigure` takes a NIC off its master within 0.1 s, as `netplan apply` would. It goes back after the hold, and there is no tug of war.
- A VLAN on the NIC with an address on it passes with the parent on the bridge, and after a delete, which leaves the parent up. `uninstall.sh`'s loops, lifted by marker into a network namespace with `eno4` moved in: both bridges gone, the OS bridge `vp80`, `vp1abc`, `vpbr200` and `br0` kept, VLAN parent up, plain NIC down. A full uninstall wasn't run here, as it would delete the owner's VMs.

The release itself, last: on the real v2.16.2 from git, plain bridges made by that code (one with a NIC brought up by hand, one floating, one with its NIC left down) and VMs running on them. The real in-app upgrade to v2.16.3 took 145 s, with the hand-off to the pulled `update.sh`. `ping -i 0.2` through both bridges for the whole of it: 1336 of 1336 answered on each over 277 s, longest gap 0.21 s. Same `ifindex`, same ports, VM not restarted, the left-down NIC now up, each network defined and inactive with autostart. A plain bridge deleted before any boot left no bridge or network, and its NIC free and down. Then a real reboot: libvirt owned both bridges (`52:54:00` MAC, `disable_ipv6` 1), the NIC went on, autostart VMs came up with leases, 17/17, nothing from libvirt in the journal.

Found by two reviewers on the diff (14 findings, all confirmed by a third, all fixed) and not by any test until then: a NIC being configured could be taken just before its address arrived; `net-define` isn't idempotent, so a crash between define and write failed for ever; a restart between two passes left VMs off the network with a clean status; `uninstall.sh` matched by name and would have taken an OS bridge called `vp<N>`; a delete took down a NIC with the host's VLAN on it.

Test traps: `modprobe -r br_netfilter` also unloads `bridge`, deleting every bridge on the host (it took the owner's networks down for a few minutes, repaired without restarting a VM; set the sysctl back instead). `tsc -p tsconfig.json` in `packages/frontend` checks nothing, as that tsconfig only holds references: use `npm --workspace @virtpilot/frontend run typecheck`, which caught a syntax error. libvirt autostarts networks once per boot, so restarting it proves nothing about boot. `pkill -f` with a pattern that appears in your own ssh command line kills the session. networkd's DHCP client asks at about 62 s and 126 s, so a server back at 61 s isn't heard from for another minute.

Observed, not fixed (not this feature): at 1024 px the NAT and bridge table scrolls sideways once a static pool's "251 of 253 free" is in it, and names wrap at their hyphens. A NAT network can still be deleted with a VM on it. Both fixed in 2.16.4.

### 2026-10-31 — v2.16.0 (callisto3-test1, Supermicro bare metal, Xeon D-1541, 31 GB, a clean Ubuntu 24.04)

The owner's test server: kernel 6.8.0-147, libvirt 10.0, a public address and no firewall of its own, so whether
strangers can reach a VXLAN was tested for real. The second machine was the dev box, 52 ms away across the internet: a VTEP
in a network namespace. Guests: Ubuntu 24.04 cloud image on KVM, plus Alpine 3.20 and an e1000e NIC for the corners.
Section 19 passed in full, from a clean state, on the final code: 58 ID checks, 69 on VMs, 28 on VLANs, 79 on tunnels, 19
corner cases, 57 through the browser and 22 after a real reboot with autostart VMs and a remote host.

Measured, and shaping the design:

- `local 127.0.0.1` still binds `0.0.0.0:4789`, and an up device takes any frame with its ID: a crafted frame from the dev
  box landed on the VMs' bridge. A down device has no socket. Hence down with no remote hosts, and per-ID rules first.
- The kernel loads `vxlan` and `xt_u32` itself under the service's sandbox (ProtectKernelModules doesn't stop it), and
  `iptables-restore --noflush` under its ambient capabilities replaces the chain atomically. No sudo rule, no helper.
- Two VLAN tags pass the bridge at the tap's own MTU: its check allows one tag over, and the kernel holds the outer tag
  as metadata. Three don't. No tap needs a higher MTU than its guest. Over a tunnel a full-size tagged frame at MTU 1450 is
  1504 to 1508 bytes on the wire, so the default is 1442, which comes to exactly 1500 with two tags. In 160,128 outer
  packets during the tests: 0 fragments and none over 1500 bytes.
- Tagged TCP between two VMs on one host: about 20 Gb/s with 0 retransmits, for 802.1Q and for QinQ either way. Across the
  tunnel: 55 to 63 Mb/s, which is the route itself (raw TCP between the two machines measured 52 to 62 Mb/s).
- A no-address VXLAN at first boot: 3 s of wait-online on Ubuntu. On Alpine, whose renderer ignores `optional`, SSH came up
  after 95 s against 32 s, the DHCP client giving up. Worth it for the times something does answer, and the wizard says so.

Found and fixed on the way, by an independent code review after the suites were green (all in the 2.16.0 notes): firewall
rules on a VXLAN-only VM put FORWARD jumps above libvirt's isolation; the SSH console and Overview each had their own
first-ARP-row lookup; a failed `virsh net-list` read as no bridges and took tunnels down; Lock IP could reserve a different
address from the one on screen; a VM that failed to create kept its pool address, which then stopped the network being
deleted; a restarted libvirt network left running VMs off the bridge; every VM start waited on the network queue with no limit.

Test traps: a capture started over ssh with `&` holds the session open, so it was over before the frames were sent and
"not delivered" passed without proving anything; run it with nohup and no shared stdout. `ether proto 0x88a8` never matches on a
bridge because the outer tag is metadata; capture unfiltered. A VM holding both VLANs answers ARP across them and proves
nothing about isolation, and leftover addresses from an earlier suite made a cross-host ping answer from the wrong VM. `systemctl
reboot` can take a minute to bite, so wait for a new boot ID, not for ssh.

The release itself, after those suites: a real in-app upgrade from a clean v2.15.0 printed the hand-off to the pulled update.sh,
finished, and passed a 14-check smoke test (both kinds of ID, two VMs, a VLAN and QinQ in the guests). `uninstall.sh --yes
--remove-install-dir` with a live tunnel up left no device, bridge, rule, chain, listener or libvirt network. The one-liner on that
box then installed 2.16.0 in 57 s, and the smoke test passed again.

Observed, not fixed (not this feature): a managed `bridge` network's interface doesn't survive a reboot, because it is made with `ip
link add` and nothing rebuilds it. A VM on one now says its network isn't running instead of "Cannot get interface MTU". Fixed in 2.16.3.

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
