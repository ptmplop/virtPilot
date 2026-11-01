# VirtPilot — KVM Manager

Web-based KVM/QEMU management UI. Monorepo with Express backend + Vite/React frontend.

## Project Structure

```
packages/backend/   Express + TypeScript — wraps virsh/libvirt
packages/frontend/  Vite + React 18 + TypeScript + Tailwind CSS v3
```

## Stack

- **Backend**: Express, TypeScript, node-pty (console WebSocket), multer (file uploads), ws
- **Frontend**: Vite, React 18, TypeScript, Tailwind CSS v3, React Query, Zustand, Axios, xterm.js
- **VM management**: libvirt via `virsh` CLI (requires `libvirt-daemon-system` on host)
- **Cloud-init**: generates `meta-data`/`user-data`, builds `seed.iso` with `genisoimage`

## Starting

### Backend
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20
cd packages/backend
cp .env.example .env   # edit storage paths and bridge
npx tsx src/index.ts
```
Backend listens on port 3001.

### Frontend
```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20
cd packages/frontend
npx vite
```
Frontend at http://localhost:5174. Proxies `/api` and `/ws` to backend.

## Install (from monorepo root)
```bash
npm install
```

## Production install (target host)

Standard install path is `/usr/local/virtpilot`. The one-liner bootstrap clones (or pulls) the repo there and hands off to `install.sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/ptmplop/virtPilot/main/bootstrap.sh | sudo bash
```

`install.sh` requires running from inside a git clone (the in-dashboard self-upgrade does `git pull` to update). It writes `VIRTPILOT_REPO_DIR=…` into `packages/backend/.env` so the backend can locate `update.sh` independently of `process.cwd()`.

## Host Requirements (Debian/Ubuntu)
```bash
apt install libvirt-daemon-system libvirt-clients qemu-kvm qemu-utils genisoimage
usermod -aG libvirt $USER
```

## Key Design Decisions

- VM/network state is derived live from libvirt via `virsh` commands — no DB caching
- A small embedded SQLite database (`$STORAGE_ROOT/virtpilot.db`) holds state libvirt doesn't track itself (currently: per-VM metrics history). See [DATABASE.md](DATABASE.md) for schema, migrations, and how to add new tables. Driver: `better-sqlite3` (synchronous, prebuilt for Node 20). When a feature needs persistent state across restarts that doesn't fit the live-from-libvirt model, add a migration in `services/db.ts` rather than inventing a new JSON file
- Console: WebSocket at `/ws/console?vm=<uuid>` → ONE shared node-pty `virsh console --force` per VM
  (a second `--force` kicks the first, so sockets share it; backlog replay, banner filter and exit reasons in
  `lib/serialConsole.ts`). `/ws/ssh` → ssh2, `/ws/vnc` → QEMU's VNC socket (QEMU shares it between viewers).
  The console window is `packages/frontend/src/components/console/` (tabs, split panes, sessions)
- Storage layout: `$STORAGE_ROOT/{templates,isos,vms,cloud-init}`
- VM creation: creates qcow2 overlay from template, generates cloud-init ISO, defines libvirt domain XML, calls `virsh define`
- Networking: bridged only; bridge must pre-exist on host
- NAT and managed bridge names: `vp0`, `vp1`, ... (libvirt network names: `virtpilot-{uuid8}`); VXLANs: bridge `vpbr<ID>`, device `vpx<ID>`
- Firewall iptables chains: `VP-IN-{vmName}`, `VP-OUT-{vmName}`; VXLAN allow-list: `VP-VXLAN`
- Copying a VM's disks (backup **and** clone) goes through `services/diskCopyService.ts`, which
  picks the best of four tiers and reports which one ran. Never call `qemu-img convert` on a
  running VM's disk directly, and never wrap a copy in a guest fsfreeze — the freeze must only
  span the *start* of the copy, not its duration
- Incremental backups are libvirt checkpoints + qemu dirty bitmaps (`services/libvirtBackupService.ts`).
  Checkpoints are named `vpbk-{backupId}`; a checkpoint with no complete backup behind it is swept by
  `reconcileCheckpoints`. Incrementals are qcow2 files backed by `../{parentBackupId}/{filename}` —
  always a *relative* path, so the backup tree stays relocatable
- Building a new VM from an existing one (clone, restore-into-a-new-VM) shares
  `services/vmDeriveService.ts`. Anything a host enforces uniqueness on must be re-keyed there:
  name, UUID, MAC addresses, NVRAM path, disk paths, VNC port, tap device names
- **Device passthrough** reads the host straight from sysfs, `lspci`, `lsblk`, `ip` and the journal
  (`services/hostScan.ts`, cached 3 s, invalidated after every change) into `lib/hostFacts.ts`; every decision
  (what is offered, IOMMU groups, why a device is hidden, host readiness, error wording) is pure code in
  `lib/hostDevices.ts`, `lib/hostdevXml.ts`, `lib/passthroughErrors.ts`, tested against snapshots of a real
  server in `lib/__fixtures__`. `services/deviceService.ts` does the libvirt side: attach writes the saved config
  first, then tries the running guest (never for a GPU or a multi-device group); a VM's devices are read from its
  own definition, live and saved, so pending and missing devices show. `checkBeforeStart` runs before every start.
- **Every VirtPilot start goes through `startDomain` in vmService**: it drops the cached `<backingStore>` from the
  saved definition first (after a disk-only snapshot libvirt keeps it one level deep, and on AppArmor hosts the
  guest's file allowlist then leaves the template out: "Permission denied" on the next boot), then the passthrough
  pre-flight, then translates known libvirt failures. Snapshot changes refresh the chain too, for autostart at boot.
- **Root work for passthrough goes through `/usr/local/sbin/virtpilot-passthrough`** (scripts/virtpilot-passthrough.sh,
  installed by install.sh and update.sh with its boot unit), called via `sudo systemd-run --wait --pipe`: the service's
  `ProtectKernelTunables` makes /sys read-only for everything it starts, plain sudo included. The helper refuses a
  mounted disk's controller and the default-route NIC itself. libvirt's `managed='yes'` sets `driver_override` while a
  VM runs, so "kept for VMs" is the helper's config file, never that attribute
- **VXLAN networks** (`lib/vxlan.ts` holds every decision, `services/vxlanService.ts` talks to the host, `networkService` owns the records): an isolated libvirt network owns the bridge `vpbr<ID>` (so it is back before any autostart VM at boot, and runs DHCP), with a kernel device `vpx<ID>` as a port. All of it runs under the service's own CAP_NET_ADMIN: `ip`, `bridge` and `iptables` need no sudo rule, and the kernel loads `vxlan` and `xt_u32` itself even under ProtectKernelModules. An up device listens on UDP on every address whatever `local` says, and takes any frame with its ID from anyone (measured from another machine), so it stays **down with no remote hosts**, and with remote hosts the `VP-VXLAN` allow-list goes in first, per ID via `-m u32`; if the rules can't be applied the tunnel goes down. `applyVxlanNetworks` rebuilds everything at startup and every 30 s, and a bridge's existence is read from sysfs, not libvirt, so a stalled libvirt can't take tunnels down. The VM firewall never targets a VXLAN NIC (`resolveFirewallTarget`): its FORWARD jumps sit above libvirt's isolation and would let other networks in. A NIC's MTU is the network's, in `<mtu>` for virtio (libvirt refuses it on other models, and it reaches the guest as host_mtu); the default keeps 8 bytes free so a guest can tag twice without the outer packet being fragmented. The bridge has `vlan_filtering` off, so guest tags pass through untouched
- **A VM's NICs** (`readNicsOf`, `withBridgeSources`, `mergeNicDefinitions` in `vmService`): `nic.source` is the bridge, however the NIC is attached, so compare it with `network.bridge`; a libvirt network VirtPilot doesn't know keeps its name. `nic.type` still says how it is attached. On a running VM the list merges both definitions, as plain `domiflist` hides a NIC saved with `--config`. `nic.onlyIn` marks a one-sided NIC, and a MAC on a different network in each is two rows, so never key on MAC alone. virsh needs `--config` or `--live` for a one-sided NIC, as `--persistent` fails: on a saved one after having removed it, on a live one with nothing done. `nic.savedType` is set where the definitions name the type differently, as a running VM says `bridge` or `direct` on a libvirt network in those modes, and virsh looks NICs up by type. A live detach returns before the guest answers. `getVmNics` and `listVmsWithNics` throw if libvirt can't say, as "no NICs" would pass the delete guard, so `getVmInfo` reads no NICs at all (the VM's page asks for them itself), and a NIC read failing can stop nothing that doesn't need one. **Any guard asking "is this VM there, is it running" uses `findVm`**, which returns null only for what virsh says it has no record of and throws otherwise: a stalled libvirt read as "gone" lets a restore or a disk move through on a running VM's disks. Anything rebuilding a VM takes its NICs from the XML it rewrites (`parseInterfacesFromXml`), never a list read apart from it. A libvirt network VirtPilot doesn't know is translated only where it owns the bridge of an OS bridge's record (`osBridgeOwners`).
- **Reads on a timer share one `virsh` process** (`virshBatch`, `lib/virshBatch.ts`): starting it costs about 40 ms, a command once connected about 3 ms. Measured on libvirt 10.0 and 11.3: a failed command prints only to stderr and virsh goes on, with an exit status that says only how the last one went, so each answer has a marker in front, a null answer means that command failed, and it's for the caller to say what that means. Words go in unquoted and virsh splits them again, so only `isBatchWord` arguments pass. The VM list reads `dominfo` alone (`listVmsRaw`): not `getVmInfo`, which costs about 9 processes a VM
- **Managed bridges** (`lib/managedBridge.ts` holds every decision, `services/bridgeService.ts` talks to the host): an isolated libvirt network with no `<ip>` owns `vp<N>`, so it is back before any autostart VM at boot, and libvirt runs no DHCP or DNS on it. libvirt can't own the physical NIC, so `applyBridgeNetworks` puts it back and brings it up at startup, ahead of anything that waits on libvirt, and every 30 s, with sysfs and one `ip` per NIC while all is in place, and no `virsh`, so libvirt can idle out. It **fails closed**: a NIC with a global address or the host's default route (either family) or another master is left alone and the Networks page says why. An address may still be on its way: once a NIC is a port DHCP can't finish, so one networkd is still `configuring` (`/run/systemd/netif/links/<ifindex>`, readable by the service, unlike the `.network` files) is held off for two and a half minutes, enough for networkd's DHCP client to ask again at about 126 s. `dhcp4: false` with no router advertisements stays `configuring` for ever, so it can't wait longer. Once the host has been seen using a NIC, `nicClaimed` on the record keeps it off while networkd manages it, through a lost address too (networkd drops them on carrier loss). A port that gains an address is let go. networkd also takes a NIC it manages off its master on every reconfigure. `net-define` isn't idempotent (no `<uuid>` in the XML, so libvirt refuses the name second time): `ensureDefinition` asks first. Running VMs' taps follow a rebuilt bridge by its ifindex changing (`reconnectIfRebuilt`, shared with VXLANs), as a restart can fall between two passes. A bridge made before 2.16.3 is plain and live, with VMs on it: the upgrade only defines its libvirt network and sets it to autostart (starting it over a live bridge fails with "File exists" and does no harm), so the swap happens at the next boot, when nothing is running. Its NIC is seen to at once, like any other. Only `vp<N>` counts: an old "public" record can name an OS bridge, and libvirt must never create that. `services/libvirtBridge.ts` is shared with VXLANs: a bridge taken from under libvirt leaves it saying "already active", so a restore stops the network first, after looking again, since at boot `virsh` can wait for libvirt's own autostart. libvirt autostarts networks once per boot (`/run/libvirt/network/autostarted`), so restarting it proves nothing about boot
- **Startup side effect to know about**: `portForwardService.applyAllRules()` strips *every*
  `virtpilot-`-tagged nat PREROUTING rule on boot and re-adds only those in its own
  `port-forwards.json`. Two backends sharing a host but not a `STORAGE_ROOT` will fight over them

## Before every commit — mandatory version bump

Every commit must update all four of these. No exceptions.

1. `packages/frontend/package.json` — bump `"version"`
2. `packages/backend/package.json` — bump `"version"` to match
3. `packages/frontend/src/components/layout/Layout.tsx` — bump the hardcoded version string in the sidebar footer (e.g. `v1.7.0`)
4. `CHANGELOG.md` (repo root, Keep a Changelog format) **and** `packages/frontend/src/data/releaseNotes.ts` (TypeScript array that drives the dashboard About section) — add a new entry to both

## After pushing — publish a GitHub release

The in-dashboard self-upgrade reads the latest release from GitHub Releases. After the version-bump commit lands on `main`, publish a release so existing installs see the update:

```bash
gh release create v<version> --title "v<version>" --notes "$(awk '/^## \['<version>'\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md)"
```

The release body becomes the "release notes" preview shown on the Dashboard update card, so the CHANGELOG section for that version is the user-facing copy.

Version increment rules:
- **Patch** (x.x.N) — fixes, tweaks, cosmetic changes
- **Minor** (x.N.0) — meaningful new features or notable UX additions
- **Major** (N.0.0) — breaking changes or major rewrites

## Tests and CI

```bash
npm test                                        # vitest, backend only
npm --workspace @virtpilot/backend run typecheck # typechecks tests too
./scripts/check-versions.sh                      # the four-location version rule
node scripts/check-dashes.mjs                    # no long dashes in user-facing text (--fix rewrites)
node scripts/check-dashes.mjs --dist             # the same for the built frontend, after npm run build
shellcheck bootstrap.sh install.sh update.sh uninstall.sh scripts/*.sh
```

- Tests live beside their subject as `*.test.ts` and cover **pure logic only** —
  validators, XML generation, rule building, schedule arithmetic, chain
  resolution. Anything that shells out to `virsh`/`qemu-img` is proved on real
  hardware via [QA.md](QA.md) instead; mocking libvirt would test the mock.
- `tsconfig.json` excludes `*.test.ts` so tests never reach `dist/`;
  `tsconfig.test.json` is what typechecks them. CI fails if a test file appears
  in the build output.
- **ShellCheck runs at default severity, not `-S warning`.** The bug that had
  `install.sh` executing fragments of its own comments as root was SC2006,
  reported only at "style" — a warning-level gate sails straight past it.

## Conventions

- British English in UI copy
- No long dashes (— or –) in anything a user reads: UI, server messages, installer and upgrade output,
  README, CHANGELOG, release notes and commit messages (the upgrade window prints the pulled commits'
  subjects, and GitHub shows them on the repo page). A spaced hyphen where a dash would go, a hyphen in ranges, a word
  for a missing value (see packages/frontend/DESIGN.md). Code comments are exempt. Checked in CI.
- camelCase TypeScript throughout
- Tailwind CSS v3 with `darkMode: 'class'` — same CSS variable palette as hostedai-launchpad
- Dark mode stored in `localStorage` key `virtpilotTheme`
- **When a feature requires a new host package**, always update **both** `install.sh` (apt-get install block) and `update.sh` (apt packages section) in the same commit.
