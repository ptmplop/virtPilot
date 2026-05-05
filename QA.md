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

## Findings log

Append per-run findings here. Format: `### YYYY-MM-DD — vX.Y.Z (host)` then bullet list.

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
