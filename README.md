<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/frontend/public/brand/virtpilot-horizontal-dark.svg">
    <img src="packages/frontend/public/brand/virtpilot-horizontal.svg" alt="VirtPilot" width="360">
  </picture>
</p>

A lightweight, web-based KVM/QEMU management UI that installs on top of a minimal Ubuntu setup, making it easy to create, run and test virtual machines without wrestling with command-line tools. Manage VMs, networks, snapshots, backups and ISOs directly from your browser, powered by libvirt and virsh on the host.

VirtPilot does not run a control plane, an agent, or a database of truth. VM state is read live from libvirt; templates and ISOs sit on disk; the only persisted state is a small SQLite file for things libvirt does not track itself (per-VM metrics history).

---

## Features

- **VMs** - create from cloud images with cloud-init, BIOS or UEFI (OVMF + swtpm), live console via `xterm.js` over a WebSocket-backed `virsh console`; clone any VM into an independent copy without shutting it down
- **Templates & ISOs** - qcow2 backing chain (overlay per VM), upload custom ISOs, convert a running snapshot back into a template
- **Networking** - bridged interfaces (host bridge required) and managed NAT bridges (`vp0`, `vp1`, …); per-NIC bandwidth shaping via Linux `tc`; per-VM iptables firewall chains
- **Snapshots** - internal and external (disk-only and live with RAM); size column shows on-disk cost
- **Backups** - full and incremental (libvirt checkpoints + qemu dirty bitmaps), scheduled or on demand, locally or to a configurable `BACKUP_ROOT` (e.g. NFS mount). Restore over the original VM, or rebuild the whole machine as a new one. See [Backups](#backups)
- **Metrics** - Live / 1h / 24h history per VM; CPU, memory, disk, network; survives backend restarts
- **Auth** - single-password login + optional TOTP; JWT in `httpOnly` cookie
- **Self-upgrade** - Dashboard polls GitHub Releases and runs `update.sh` in a transient systemd unit; live build output streamed back to the browser

---

## Install

### One-liner (recommended)

On a fresh Ubuntu 24 host, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/ptmplop/virtPilot/main/bootstrap.sh | sudo bash
```

`bootstrap.sh`:

1. Installs `git` if missing
2. Clones (or pulls) the repo into `/usr/local/virtpilot`
3. Hands off to `install.sh`

`install.sh`:

1. Installs APT dependencies - `qemu-kvm`, `libvirt-daemon-system`, `libvirt-clients`, `virtinst`, `ovmf`, `swtpm`, `swtpm-tools`, `genisoimage`, `bridge-utils`, `iptables`, `curl`, `openssl`, `build-essential`, `python3`
2. Installs Node.js 20 from NodeSource (skipped if already present)
3. Enables and starts `libvirtd`
4. `npm install` and `npm run build` for both packages
5. Creates `/var/lib/virtpilot/{templates,isos,vms,cloud-init,backups}`
6. Prompts for a web-UI password (8+ chars) and writes `packages/backend/.env` with a fresh JWT secret
7. Installs and starts the `virtpilot.service` systemd unit

When it finishes you get:

```
Web UI:   http://<host-ip>:3001
Password: the one you just set
```

### Manual install

If you'd rather see what's happening:

```bash
sudo git clone https://github.com/ptmplop/virtPilot.git /usr/local/virtpilot
cd /usr/local/virtpilot
sudo bash install.sh
```

`install.sh` insists on being run from inside a git clone - the in-dashboard self-upgrade runs `git pull`, so a tarball install would break updates.

---

## Updating

From the Dashboard, click **Update** on the version card - it streams build output into a modal and reloads when the backend comes back on the new version.

From the shell:

```bash
cd /usr/local/virtpilot
sudo bash update.sh         # no-op if already at HEAD
sudo bash update.sh --force # rebuild even when up to date
```

---

## Backups

### Full and incremental

A **full** backup copies every allocated block of each disk into
`${BACKUP_ROOT}/<vm-uuid>/<backup-id>/`. An **incremental** copies only what
changed since the previous backup, and is stored as a qcow2 whose backing file
points at its parent (`../<parent-id>/disk.qcow2`). A chain therefore reads as
one complete image - restoring any link flattens the whole chain automatically.

Incrementals need three things:

| Requirement | Why |
|---|---|
| The VM is running | libvirt cannot read a dirty bitmap from a stopped domain |
| `virsh domcapabilities` reports `<backup supported='yes'/>` | needs libvirt ≥ 6.0 and a qemu with `blockdev-backup` - Ubuntu 22.04+ |
| The previous backup recorded a checkpoint | the bitmap lives in the qcow2, and the checkpoint is what names it |

When any of these is missing, the run takes a **full** backup instead and records
why on the backup - a schedule never silently skips.

Schedules choose between *always full* and *incremental with a fresh full every
N backups*. Capping the chain length is deliberate: a long chain is slower to
restore, and every link after a damaged one is lost with it.

### Chain safety

- Deleting a backup that later incrementals build on is **refused**. The dialog
  offers to delete the whole subtree instead.
- Retention obeys the same rule: an expired full backup that still has a live
  incremental on top of it is kept until that incremental expires too.
- A backup whose ancestors have gone missing is marked **chain broken** and
  cannot be restored - rather than handing back a silently corrupt disk.

### How the copy is taken

Backing up a *running* VM never freezes its filesystems for the length of the
copy. Four mechanisms, best first; each backup records which one ran.

| Method | When | Guest impact |
|---|---|---|
| `libvirt-backup` | running host with backup support | freeze lasts as long as the job takes to start (ms) |
| `snapshot-convert` | running, no backup support | pivots onto a throwaway overlay, commits it back |
| `direct-convert` | running, both of the above failed | none, but crash-consistent |
| `offline-convert` | VM is off | none |

Only `libvirt-backup` can produce incrementals.

### Restoring

- **Roll back** - replaces the source VM's disks. The VM must be stopped.
- **New VM** - rebuilds the entire machine from the backup's stored domain
  definition: new UUID, new MAC addresses, a fresh IP where the original held a
  static one, its own NVRAM, and a regenerated cloud-init seed so the guest
  boots under the new name. Works even if the original VM has been deleted.

Both flatten any incremental chain, so the restored VM gets one standalone image.

## Host requirements

- Ubuntu 24 (the installer warns and continues on other distributions, but is only tested here)
- Root access (the installer needs to install packages, write `/etc/systemd/system`, and create `/var/lib/virtpilot`)
- KVM-capable CPU (VT-x / AMD-V) - VirtPilot does not run nested or software-only
- A pre-existing host bridge if you want bridged networking - typically `br0`. Set `DEFAULT_BRIDGE` in `.env` if you use a different name. NAT bridges are managed by VirtPilot itself and need no setup.

---

## Configuration

`packages/backend/.env` is generated by the installer. The interesting knobs:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | HTTP + WebSocket port |
| `STORAGE_ROOT` | `/var/lib/virtpilot` | Parent directory for everything below |
| `TEMPLATES_DIR` | `${STORAGE_ROOT}/templates` | qcow2 templates |
| `ISOS_DIR` | `${STORAGE_ROOT}/isos` | Uploaded ISOs |
| `VMS_DIR` | `${STORAGE_ROOT}/vms` | Per-VM overlays and seed ISOs |
| `CLOUD_INIT_DIR` | `${STORAGE_ROOT}/cloud-init` | Generated `meta-data` / `user-data` |
| `BACKUP_ROOT` | `${STORAGE_ROOT}/backups` | Override to keep backups off the system disk (e.g. `/mnt/nfs/virtpilot-backups`) |
| `DEFAULT_BRIDGE` | `br0` | Host bridge for bridged interfaces |
| `LIBVIRT_URI` | `qemu:///system` | Libvirt connection URI |
| `AUTH_PASSWORD` | _(prompted)_ | Web-UI login password |
| `JWT_SECRET` | _(generated)_ | 256-bit hex string |

Restart after editing: `sudo systemctl restart virtpilot`.

---

## Useful commands

```bash
systemctl status virtpilot         # is it up?
journalctl -u virtpilot -f         # tail the logs
sudo systemctl restart virtpilot   # apply .env changes
virsh list --all                   # what VMs does libvirt see?
```

---

## Architecture

```
packages/backend/   Express + TypeScript - wraps virsh / libvirt / qemu-img
packages/frontend/  Vite + React 18 + TypeScript + Tailwind CSS
```

- **Live state from libvirt.** `virsh` is the source of truth for VMs, networks, and snapshots. There is no shadow database to fall out of sync.
- **One small SQLite file** at `${STORAGE_ROOT}/virtpilot.db` for state libvirt doesn't track itself - currently per-VM metrics history. See [DATABASE.md](DATABASE.md) for the schema and migration pattern.
- **Console** - `/ws/console?vm=<name>` over WebSocket → `node-pty` → `virsh console`.
- **Cloud-init** - `meta-data` and `user-data` written under `cloud-init/<vm>/`, packed into `seed.iso` with `genisoimage`, attached as a virtual CD on first boot.

---

## Development

```bash
git clone https://github.com/ptmplop/virtPilot.git
cd virtPilot
npm install

# backend on :3001
cd packages/backend
cp .env.example .env   # edit storage paths and bridge
npx tsx src/index.ts

# frontend on :5174 (proxies /api and /ws to the backend)
cd packages/frontend
npx vite
```

Node.js 20 is required.

See [CLAUDE.md](CLAUDE.md) for project conventions, the version-bump checklist, and notes on adding new features.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Releases are also published on [GitHub Releases](https://github.com/ptmplop/virtPilot/releases) - the in-dashboard self-upgrade reads from there.
