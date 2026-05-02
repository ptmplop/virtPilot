# Changelog

All notable changes to VirtPilot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.15.2] — 2026-05-02

### Fixed
- **Defence-in-depth for the self-update lockfile-drift abort fixed in v1.15.1.** The backend's `/api/system/upgrade` handler now also runs `git checkout -- package-lock.json` in the repo dir immediately before spawning `update.sh` via `systemd-run`. v1.15.1's `update.sh` already does the same cleanup internally, so this is belt-and-braces — the orchestrator (backend) ensures the precondition even if a future `update.sh` ever loses its own cleanup. No effect on installs already running cleanly; existing installs stuck at ≤ v1.15.0 still need the one-time SSH unblock from the v1.15.1 release notes since their backend code predates this fix

## [1.15.1] — 2026-05-02

### Fixed
- **Self-update no longer aborts when `package-lock.json` has been mutated by a previous `npm install` on the host.** The first `npm install` after a fresh checkout regenerates `package-lock.json` with the host's platform-specific binary entries (e.g. linux-x64) that aren't in the macOS-generated lockfile committed upstream — leaving the working tree dirty and causing the next `git pull --ff-only` to abort with "Your local changes to the following files would be overwritten by merge: package-lock.json". `update.sh` now does `git checkout -- package-lock.json` immediately before the pull so any drift from the previous run is discarded. Existing stuck installs need a one-time manual unblock: `cd /usr/local/virtpilot && git checkout -- package-lock.json && bash update.sh` (path is wherever the install lives — `/root/ptm/virtPilot` in some cases)

## [1.15.0] — 2026-05-02

### Changed
- **Per-VM metric charts redesigned for clarity.** The four charts on the VM Metrics tab (CPU, Memory, Disk I/O, Network I/O) now stack one per row instead of a 2×2 grid, giving each chart the full content width. Each chart gained a labelled Y axis (5 ticks: 0/25/50/75/100 % for CPU and Memory; auto-scaled byte values for Disk and Network), a labelled X axis with timestamps (`HH:MM:SS` for Live, `HH:MM` for 1h, `DD/MM HH:MM` for 24h), and dashed horizontal grid lines so the eye can read off values without hovering. Plot height grew from 72 px to 200 px. Disk and Network charts now scale their Y axis to a "nice" round maximum derived from the actual data (1, 2, 5 or 10 × 10ⁿ) rather than the largest value in the series — small spikes no longer compress flat traffic into the baseline. New `MetricChart` component in `components/ui/`; the existing `AreaChart` sparkline (used by the Dashboard live tiles) is unchanged

## [1.14.0] — 2026-05-02

### Added
- **ISO uploads and URL downloads now accept compressed `.iso.gz` and `.iso.tar.gz` files** (also bare `.gz` and `.tgz`). The server detects the format via gzip magic bytes (`0x1f 0x8b`) plus the file extension, decompresses streamingly using Node's built-in `zlib` for plain gzip and the `tar` package for `.tar.gz`, and writes a plain `.iso` to the storage directory. No need to gunzip a pfSense release locally before uploading. For tar.gz archives the first `.iso` entry is extracted (additional files in the archive are ignored). The ISOs page subtitle, empty state, upload dialog, and URL download dialog all explain the supported formats. URL downloads gained a `processing` status that surfaces a "Decompressing" indicator on the progress card while the post-download decompression runs. The frontend file picker `accept` attribute now allows `.iso,.gz,.tgz`, and the auto-derived display name strips compound extensions (`pfSense-CE-2.7.2-RELEASE-amd64.iso.gz` → `pfSense-CE-2.7.2-RELEASE-amd64`)

## [1.13.9] — 2026-05-02

### Fixed
- **ISO and Template uploads/downloads no longer leak partial files into the listing or onto disk.** Three related issues across both routes:
  - **URL downloads were appearing in the list while still in flight.** The download stream wrote straight to the final destination path with the real `.iso` / `.qcow2` extension, and `useDownload*FromUrl`'s `onSuccess` (which fires when the POST returns, i.e. when the download just *started* server-side) eagerly invalidated the listing query — so the half-written file showed up immediately. Server now streams to `${dest}.part` and atomically renames on completion; the early `invalidateQueries` is gone, so the listing only refreshes when polling sees `status === 'done'`.
  - **No way to cancel a URL download.** Added `DELETE /api/{isos,templates}/download/:jobId`, which destroys the in-flight HTTP request and write stream and removes the `.part` file. The download progress card now renders the same X cancel button as the browser-upload card. Status enum gained `'cancelled'` and the polling hook surfaces it as a "Download cancelled" toast.
  - **Cancelled browser uploads were leaving multer temp files behind.** With `multer({ dest })`, an aborted upload mid-stream leaves a 32-hex-named temp file in the storage directory forever — they don't show in the listing (no `.iso`/`.qcow2` extension) but they consume disk silently. Both upload routes now wire `req.on('aborted')` and the catch path to unlink `req.file.path`.

## [1.13.8] — 2026-05-02

### Added
- "Check now" button on the VirtPilot version card on the Dashboard. Bypasses the backend's 10-minute GitHub release cache so a freshly published release shows up immediately instead of waiting for the next 5-minute polling tick (which itself can hit a stale cache). Available in all three states of the card (up to date, update available, in-app upgrade unavailable). Backend gained a `?force=1` query param on `GET /api/system/version`; frontend exposes a new `useCheckVersionNow` mutation that primes the React Query cache with the fresh response

## [1.13.7] — 2026-05-02

### Changed
- Redesigned every tile on the Dashboard around the visual language of the "Update available" card. The Host identity card, the four small stat tiles (VMs, Disk, Memory, System Updates), and the four Live Metrics cards (CPU, Memory, Disk I/O, Network) all now share: rounded-2xl shells with layered radial gradient backgrounds plus two blurred colour orbs in opposing corners, a coloured top accent stripe, a glowing icon badge with gradient fill and ring, accent-coloured uppercase labels and big primary values, and a stronger hover glow. One source of truth (`ACCENT_CFG` in `Dashboard.tsx`) now powers every accent — `neutral`, `ok` (emerald), `warn` (amber), `blue`, and `violet` — so the palettes stay perfectly consistent. `MetricCard` lost four bespoke styling props (`color`, `accentBg`, `chartBgClass`, `glowClass`) in favour of a single `scheme` prop that picks the whole palette

## [1.13.6] — 2026-05-02

### Fixed
- Login page no longer says "Invalid password" when the real reason is the IP allowlist. The backend now returns a distinct 403 with the client's IP, and the login form shows "Access denied — your IP address X.X.X.X is not on the allowlist. Contact your administrator." Same handling on the TOTP step. Affects `/api/auth/login`, `/api/auth/verify-totp`, and the `requireAuth` middleware

## [1.13.5] — 2026-05-02

### Fixed
- Improved readability of the VirtPilot version cards. Dropped the `bg-clip-text` gradient text trick on version numbers (pale gradient on tinted background was low contrast in both light and dark mode); version numbers now render as solid theme-aware colours (`text-blue-700 dark:text-blue-200` for the new version, emerald equivalents for up-to-date). Old version is now struck through. Backgrounds toned down (gradient and radial blur opacities cut by ~40%) so text wins. Small uppercase labels brightened from `…/80` to full opacity with explicit dark-mode variants

## [1.13.4] — 2026-05-02

### Changed
- Up-to-date variant of the VirtPilot version card now matches the visual weight of the Update-available variant — same rounded-2xl card with layered radial gradients, same h-12 glowing icon badge, same big monospace version display with gradient-clipped text. Just emerald instead of blue/violet, and a "View latest release" link instead of an Update CTA. The two states finally feel like siblings of one component instead of unrelated widgets

## [1.13.3] — 2026-05-02

### Changed
- Moved the VirtPilot version card out of the Overview section into its own labelled "VirtPilot" section on the Dashboard, matching the structure of the other sections (Overview, Live Metrics, System)

## [1.13.2] — 2026-05-02

### Changed
- Redesigned the "Update available" card on the Dashboard — bigger, layered blue-to-violet gradient background with radial accents, large monospace version transition with gradient text on the new version, glowing sparkle badge, and a custom gradient "Update now" button with hover shimmer. The inline release-notes preview is gone in favour of a single "View release notes" link to the GitHub release page

## [1.13.1] — 2026-05-02

### Changed
- VirtPilot version card on the Dashboard is now always visible — when up to date it shows a compact green strip with the current version and a link to the latest release. Previously it was hidden entirely until an update was available, which made it look like the feature wasn't there

## [1.13.0] — 2026-05-01

### Added
- **In-dashboard self-upgrade.** A new card under Overview on the Dashboard polls GitHub Releases and surfaces when a newer VirtPilot version is available. One click runs `update.sh` inside a transient systemd unit (`virtpilot-update.service`), streams live `git pull` / `npm install` / `npm run build` output into a terminal modal, and waits for the backend to come back on the new version before reloading the page. Backend exposes `GET /api/system/version` and an SSE `GET /api/system/upgrade`. Latest-release lookup is cached for 10 minutes to stay well inside GitHub's unauthenticated rate limit
- **`bootstrap.sh` one-liner installer.** Standardises the install path at `/usr/local/virtpilot`. Run with `curl -fsSL https://raw.githubusercontent.com/ptmplop/virtPilot/main/bootstrap.sh | sudo bash` — installs git if missing, clones (or pulls) the repo, then hands off to `install.sh`

### Changed
- `install.sh` now refuses to proceed unless run from inside a git clone (in-app upgrades require it) and warns when installing outside `/usr/local/virtpilot`. The generated `.env` records `VIRTPILOT_REPO_DIR=…` so the backend has an explicit source-of-truth for the repo path
- Backend `VERSION` constant in `config.ts` is now read from `package.json` at startup instead of being a hardcoded string that drifted out of sync (was stuck at `1.7.0`). Backup metadata picks up the live version automatically

## [1.12.1] — 2026-05-01

### Changed
- Friendlier labels in the Snapshots tab "VM State" column — `disk-snapshot` → **Disk only**, `running` → **Live (with RAM)**, `shutoff` → **Offline**. The raw libvirt values were unclear; the column describes what the snapshot captured at the moment it was taken, not the VM's current state

## [1.12.0] — 2026-05-01

### Added
- Snapshot size column on the VM Snapshots tab — the table now shows the on-disk cost of each snapshot alongside Created and VM State. For external snapshots (UEFI VMs and disk-only) it sums the overlay file sizes; for internal snapshots it reports `vm-state-size` from `qemu-img info`. Backend `GET /api/vms/:name/snapshots` now returns a `sizeBytes` field per snapshot

## [1.11.0] — 2026-05-01

### Added
- Per-VM metrics history — Metrics tab on the VM detail page now has a **Live / 1h / 24h** range selector. CPU, memory, disk and network charts read from a SQLite-backed ring buffer instead of the previous in-memory rolling window, so history survives backend restarts and extends well beyond the last few minutes
- Background sampler runs every 30 seconds, queries `virsh domstats` for every running VM, and writes one row to `vm_metrics`. The 1h range returns raw 30s samples (~120 points); the 24h range aggregates into 5-minute buckets via SQL `AVG` (~288 points). Rows older than 24 hours are pruned automatically
- `GET /api/vms/:name/metrics?range=1h|24h` returns the per-VM history; the existing `/stats` endpoint is unchanged for the live tile values
- VM rename and delete now keep the metrics table consistent — rename re-keys the rows, delete purges them
- New embedded SQLite layer at `$STORAGE_ROOT/virtpilot.db` for state libvirt doesn't track itself. Uses `better-sqlite3` (synchronous, prebuilt for Node 20), WAL journaling, and `user_version`-pragma migrations. Schema, migration pattern, and integration points are documented in [DATABASE.md](DATABASE.md) so future features can add tables alongside the metrics one

## [1.10.0] — 2026-05-01

### Added
- Per-NIC bandwidth shaping — VMs Network tab now lets you set inbound and outbound rate limits in MB/s for each interface; libvirt enforces them via Linux tc (token bucket) on the host tap device. Limits apply live (`virsh domiftune --live --config`) so no shutdown is required, and they persist across reboots
- Rate Limit column on the per-VM Network tab shows the active cap per NIC (or "unlimited"); a gauge/pencil button next to each row opens an inline editor with two numeric fields. Blank or zero clears the cap
- Same inbound/outbound fields available in the Add NIC dialog so newly attached interfaces can be shaped at attach time
- `PUT /api/vms/:name/nics/:mac/bandwidth` route for setting/clearing limits on an existing NIC; bandwidth values round-tripped through the VM detail response (`inboundKbps`, `outboundKbps` on each NIC, KiB/s)

## [1.9.3] — 2026-05-01

### Changed
- Convert-snapshot-to-template now reads the source template from the VM's stored metadata (recorded at create time) instead of inspecting one level of the qcow2 backing chain — the new template inherits the original template's logo correctly even when external snapshot overlays sit between the active disk and the template

## [1.9.2] — 2026-05-01

### Fixed
- External snapshot delete on running VMs no longer fails with `Failed to get "write" lock` when the VM is cloned from a shared template — `blockcommit` was walking the entire backing chain down to the read-only template (held R/O by every other cloned VM); now pinned to overlay → immediate backing only via explicit `--top`/`--base`

## [1.9.1] — 2026-05-01

### Fixed
- ISO and template upload cancel (the X button next to the progress bar) now actually aborts the upload — the abort callback was previously stored as a thunk that returned the abort function instead of calling it, so clicking X did nothing

## [1.9.0] — 2026-05-01

### Added
- Snapshot support for UEFI VMs: when a VM uses pflash firmware (where QEMU can't store internal snapshots), VirtPilot now takes external `--disk-only` snapshots instead, creating a per-disk qcow2 overlay alongside each persistent disk
- Revert and delete paths handle both internal and external snapshots transparently — external revert restores the saved domain XML and caps the sealed disk with a fresh overlay so the snapshot point stays re-revertible; external delete merges the active overlay back into its backing via `blockcommit --active --pivot` (running) or `qemu-img commit` (offline) and removes the snapshot metadata
- Convert-to-template works for external snapshots by reading directly from the snapshot's sealed backing file

### Fixed
- "internal snapshots of a VM with pflash based firmware are not supported" error when snapshotting modern UEFI guests

## [1.8.5] — 2026-05-01

### Changed
- Dashboard visual polish: coloured per-metric top accent stripe on all four MetricCards (blue/violet/amber/emerald matching their chart colour); coloured hover glow per card
- StatTile now supports `blue` and `violet` accent types; Virtual Machines tile uses blue accent instead of neutral
- Running VM dots in the VM tile now pulse with `animate-glow-pulse`
- Host identity card top stripe thickened and made more opaque; card gains a coloured hover shadow (emerald for KVM, amber for TCG)
- System Updates card gains a coloured top stripe (emerald = up to date, amber = updates available)
- MetricCard chart area background gradient slightly stronger for better contrast against the chart line

## [1.8.4] — 2026-05-01

### Changed
- Settings page sections now use `space-y-8` spacing with the same `SectionLabel` style as the Dashboard (tiny uppercase tracking label with a left accent bar) instead of plain `<h2>` headings

## [1.8.3] — 2026-05-01

### Changed
- Host Configuration section in Settings now includes a tip below the config table explaining that `BACKUP_ROOT` can point to a mounted second disk or NAS share for external backup storage

## [1.8.2] — 2026-05-01

### Changed
- Templates, ISOs, Networks, Virtual Machines, SSH Keys, and Storage pages now have stat cards at the top (coloured icon accents, bold value, uppercase label) matching the Backups page pattern
- Storage page ResourceCard updated to use the same icon-left layout as StatCard with per-type colour accents (violet/blue/emerald)
- Virtual Machines page subtitle simplified to static string; counts moved into stat cards

## [1.8.1] — 2026-05-01

### Changed
- UI consistency pass across all pages: standardised card shadows to `shadow-sm`, unified empty-state layout (py-20, h-14 w-14 icon wrapper, h-6 w-6 icon), aligned table header styles (bg-muted/40, font-semibold, tracking-widest), and table row padding to py-3.5
- Logs page empty state now matches the style used on all other pages
- Spinner component now used consistently for all loading indicators — replaced ad-hoc Loader2 usage in VmConsole and Login
- Physical NIC picker in the Create Network dialog now uses the Select component instead of a raw select element
- "History →" link in the Backups table now uses the Button ghost variant

## [1.8.0] — 2026-05-01

### Added
- Backup progress indicator — a live in-progress row appears at the top of the per-VM backup table while a backup is running (manual or scheduled), showing a spinner and animated progress bar matching the snapshot pattern; the backup list overview also dims the row, shows a progress bar under the VM name, and replaces the Last Backup value with "Backing up…"; state is driven by a polled `/api/backups/running` endpoint so the indicator persists when navigating away and returning

### Fixed
- Large backup and restore operations no longer time out — Axios timeout disabled (set to 0) for the create-backup and restore API calls which can run for many minutes on large disks

## [1.7.0] — 2026-04-30

### Added
- Two-factor authentication — Settings page includes a 2FA section; when enabled, login requires a 6-digit TOTP code from an authenticator app (Google Authenticator, Authy, etc.) after the password; users can remove 2FA at any time from Settings

## [1.6.0] — 2026-04-30

### Added
- IP Access Control — Settings page now includes an IP whitelist; when one or more entries are present, only those IPs (or CIDR ranges) can log in or make API/WebSocket requests; empty list allows all IPs (no behaviour change for existing installs)

## [1.5.1] — 2026-04-30

### Changed
- VM Overview: resource cards now have colour-coded icon accents (blue/violet/amber/teal) and larger value text
- VM Overview: copy-to-clipboard buttons added for IP address, username, password, SSH command, and UUID
- VM Overview: section headings changed to compact uppercase tracking style

## [1.5.0] — 2026-04-30

### Added
- VM rename — pencil icon next to the VM name on the detail page appears when the VM is stopped; clicking it opens an inline input pre-filled with the current name; saving calls `PUT /api/vms/:name/rename` which undefines and redefines the libvirt domain with the new `<name>` element, then updates vm-metadata, port-forwards, DHCP reservations, and the per-VM firewall config file; the page navigates to the new URL on success

## [1.4.3] — 2026-04-30

### Changed
- Sidebar collapse toggle moved from the footer into the brand bar — icon sits to the right of the logo when expanded, below the logo when collapsed
- Sign out is now a full-width labelled button in the expanded sidebar footer with a red hover state; icon-only collapsed variant also gains the red hover

## [1.4.2] — 2026-04-30

### Fixed
- APT upgrade terminal no longer colours stderr output red — apt-get writes normal progress to stderr, causing routine lines to appear as errors; all output now renders in the same colour with failure indicated only by the footer exit-code status

## [1.4.1] — 2026-04-30

### Fixed
- Metric card left panel widened from w-48 to w-56 so long formatted values (e.g. "159.98 B/s") no longer overflow in the two-column grid layout

## [1.4.0] — 2026-04-30

### Changed
- Dashboard layout redesigned: five-tile row and four full-width metric sections replaced with a host identity card + 2×2 stat grid and a single 2×2 live metrics grid, greatly reducing scroll and visual repetition
- Host identity card now shows hostname, CPU model and core count, libvirt driver URI, colour-coded load averages (scaled to core count), and live network RX/TX rates
- Metric card legends (Read/Write, RX/TX) moved inside the left panel; secondary value stacked below primary to prevent overflow in the narrower grid layout
- About section removed from the dashboard

### Added
- `GET /api/system/info` backend endpoint exposing hostname, CPU model/cores, load averages (1 m, 5 m, 15 m), and kernel version via `/proc/cpuinfo`, `/proc/loadavg`, and `uname -r`
- Progress bars on Disk Space and Memory stat tiles showing fill level at a glance
- VM status dots on the Virtual Machines tile — glowing emerald dots for running VMs, muted dots for stopped

## [1.3.0] — 2026-04-30

### Added
- SSH Keys management section in the sidebar — save public keys with a friendly name and reuse them across VM provisioning
- VM provisioning wizard now shows a checkbox list of saved SSH keys instead of a free-form textarea; zero or more keys can be selected per VM

## [1.2.6] — 2026-04-30

### Fixed
- VM deletion now passes `--nvram` and `--tpm` to `virsh undefine` so VMs with UEFI/Secure Boot or vTPM can be deleted without error; previously libvirt would refuse to undefine them because the associated NVRAM and TPM state files were not explicitly removed

## [1.2.5] — 2026-04-30

### Changed
- Resources section on the Overview tab now shows a hint ("Shut down the VM to edit CPU and memory allocation") beneath the cards when the VM is not stopped

## [1.2.4] — 2026-04-30

### Fixed
- Secure Boot VMs now use `OVMF_VARS.ms.fd` (Microsoft keys pre-enrolled) as the NVRAM template instead of the empty `OVMF_VARS.fd`; previously the firmware booted in Setup Mode with no Platform Key, so Secure Boot was always reported as disabled inside the guest

## [1.2.3] — 2026-04-30

### Changed
- Resource Edit button on the Overview tab is now always visible; it is disabled and shows a tooltip ("Stop the VM to resize CPU or memory") when the VM is running, rather than being hidden entirely

## [1.2.2] — 2026-04-30

### Added
- Virtual TPM 2.0 support — enables full Windows 11 compatibility; added to the VM definition via libvirt's emulated TPM backend

## [1.2.1] — 2026-04-30

### Added
- UEFI/OVMF firmware support with optional Secure Boot — selectable per-VM at creation time; stored in the domain XML loader configuration

## [1.1.8] — 2026-04-30

### Changed
- Device passthrough list now uses an allowlist of PCI class codes — only Storage, Network, Display, Multimedia, Input, Serial Bus, Wireless, Encryption, and Signal Processing devices are shown; bridges, processor sub-functions, memory controllers, system peripherals, and other non-passthrough-able classes are filtered out at the backend

## [1.1.7] — 2026-04-30

### Changed
- PCI devices in the Available Devices list now show an amber warning indicator next to the driver name when the host kernel is actively using the device (driver is not `vfio-pci` and not unbound) — hovering reveals a tooltip explaining that attaching will unbind it from the host

## [1.1.6] — 2026-04-30

### Added
- PCI and USB device passthrough tab on the VM detail page — browse all host devices, see which are available or already assigned to another VM, and attach/detach with one click
- `GET /api/devices` endpoint enumerates host PCI and USB devices via `virsh nodedev-list/dumpxml` and annotates each with the VM it is currently assigned to (if any)
- `POST /api/vms/:name/devices` and `DELETE /api/vms/:name/devices/:deviceId` routes for attaching and detaching; operations logged via the existing audit log
- PCI passthrough uses `managed='yes'` so libvirt handles vfio-pci driver binding/unbinding automatically; USB passthrough matches by vendor+product ID so it survives device reconnects

## [1.1.5] — 2026-04-29

### Changed
- "Add NIC" idle warning now says "Configuration steps will be shown after adding" instead of referencing netplan specifically
- "Add NIC" success view now clarifies the snippet is an Ubuntu / Debian (netplan) example and instructs the user to adapt it for other distributions or Windows

## [1.1.4] — 2026-04-29

### Fixed
- Network type badges now correctly label existing-bridge networks as "OS Bridge DHCP" / "OS Bridge Static" instead of "Bridge DHCP" / "Bridge Static" — applies to both VM creation and VM detail views

## [1.1.3] — 2026-04-29

### Fixed
- "Add NIC" now tracks the new interface in VM metadata (networkId, MAC, allocated IP) so the network tab reflects it correctly across reboots and detail loads
- Removing a NIC now also cleans up its entry in VM metadata and releases any static IP allocation back to the pool
- `IpCell` now shows "DHCP · unresolved" for `existing-bridge` DHCP NICs instead of "—"

### Changed
- "Add NIC" backend now generates and pins the MAC address (passed as `--mac` to `virsh`) so the allocated MAC matches what is recorded in metadata
- `POST /api/vms/:name/nics` now requires `networkId`; for static networks it also requires `staticIp` and allocates it from the pool
- After adding a NIC, the dialog transitions to a success view showing a ready-to-paste netplan snippet (with correct MAC and IP config) for manual configuration inside the VM
- Static network IP picker shown in the "Add NIC" dialog when the selected network uses static allocation

## [1.1.2] — 2026-04-29

### Changed
- "Allow established & related" checkboxes are disabled (dimmed) when the corresponding default policy is "Allow all" — they are redundant in that state
- Switching a default policy to "Drop all" now automatically enables the corresponding "Allow established & related" checkbox to prevent cutting off return traffic; switching back to "Allow all" clears it

## [1.1.1] — 2026-04-29

### Fixed
- "Allow established & related" checkboxes now persist — PUT route was stripping the new boolean fields before saving

## [1.1.0] — 2026-04-29

### Added
- Firewall rule reordering via up/down buttons on each row
- Multi-port support in firewall rules — comma-separated ports and ranges (e.g. `80,443` or `80,8000-9000`) via iptables multiport module
- ICMP type filtering — dropdown replaces port field when protocol is ICMP (echo-request, echo-reply, destination-unreachable, time-exceeded, redirect)
- Stateful connection tracking — per-direction "Allow established & related" checkbox in Default Policies; inserts `conntrack ESTABLISHED,RELATED` rule at the top of the chain
- Port field now shows `any` in the rules table when no port is specified; label clarifies blank = any

## [1.0.15] — 2026-04-29

### Added
- Firewall rules now support source address (inbound) and destination address (outbound) — accepts IP or CIDR notation
- Edit button on each firewall rule row; opens a pre-populated dialog to modify any field in place

## [1.0.14] — 2026-04-29

### Changed
- Sidebar is always dark in both light and dark mode

## [1.0.13] — 2026-04-29

### Changed
- Sidebar brand area replaced with PNG logo assets: `vlogo-big.png` (wordmark) when expanded, `vlogo-small.png` (icon) when collapsed

## [1.0.12] — 2026-04-29

### Changed
- Radial blue bloom background on body (light: top-right, dark: top-left)
- Airy card shadows in light mode; weighted in dark mode
- Status dots breathe with `glow-pulse` animation (2 s ease-in-out)
- Cards fade up on page load with staggered 60 ms delays
- Sidebar uses cool off-white (`hsl(220 20% 97%)`) in light mode with hairline border
- Light mode is now the default theme (was dark)
- Active nav item uses `from-primary/10` gradient fill; collapsed active state updated to match
- Dashboard SectionLabel: wider letter-spacing, left accent bar, reduced opacity
- StatTile: per-accent glow on hover (emerald/amber), glossy top-edge sheen, badge radial highlight
- MetricCard: per-chart colour wash behind SVG, gradient metric value, gradient divider
- AboutSection app name and sidebar brand text both use gradient `bg-clip-text` treatment
- Interactive elements upgraded to `transition-all duration-200 ease-out`

## [1.0.11] — 2026-04-29

### Changed
- Sidebar restyled to match HostedAI Launchpad: bg-sidebar token, left-border active state, semantic colour tokens throughout
- Sidebar collapsed to 240px max-width (from 320px)
- Card rounding standardised to rounded-xl across all pages (was rounded-2xl in Dashboard and Vms)

## [1.0.10] — 2026-04-29

### Changed
- System Updates overview tile shows count only, without "pending" label

## [1.0.9] — 2026-04-29

### Changed
- Dashboard metric graphs (CPU, Memory, Disk I/O, Network) are now each full width in their own section

## [1.0.8] — 2026-04-29

### Changed
- System Updates card is now full width on the dashboard
- Virtual Machines card removed from dashboard

## [1.0.7] — 2026-04-29

### Changed
- Host Configuration moved from dashboard to Settings page

## [1.0.6] — 2026-04-29

### Fixed
- APT upgrade EventSource failing immediately: pass JWT as `?token=` query param; `requireAuth` now accepts token from query string as fallback for SSE/EventSource requests that cannot set headers

## [1.0.5] — 2026-04-29

### Changed
- About section moved below Overview, now full-width with expanded description, feature tags, stack tags, and GitHub link
- Release notes removed from dashboard; GitHub repo link replaces them

## [1.0.4] — 2026-04-29

### Changed
- Dashboard System section: Host Configuration moved below APT/VM cards as borderless key-value layout
- Dashboard About section: removed card chrome, now renders as borderless text layout

## [1.0.3] — 2026-04-29

### Fixed
- Dashboard section cards now match height within each row

## [1.0.2] — 2026-04-29

### Added
- About section on dashboard showing software info and release notes

## [1.0.1] — 2026-04-29

### Added
- Guest agent status display on VM overview
- Freeze/thaw filesystems on snapshot for guest-agent-enabled VMs
- Hard reset and force-off actions on VM detail page
- Persist template/ISO upload progress across navigation with cancel support

### Changed
- Lighten sidebar version label for legibility

## [1.0.0] — 2026-04-28

### Added
- Initial release (rebranded from ptmvm)
- KVM/QEMU VM management via libvirt (create, start, stop, delete, snapshot)
- Serial console access via WebSocket and xterm.js
- VNC remote display via noVNC
- Cloud-init provisioning with static IP support
- Network management: bridged and NAT (libvirt networks)
- Firewall rules via iptables with per-VM chains
- Template and ISO file management with upload progress tracking
- Live system metrics dashboard (CPU, memory, disk I/O, network)
- APT system update management with streaming upgrade terminal
- Host configuration via environment variables
- Self-contained installer (install.sh) and in-place updater (update.sh)
- Port forwarding management
- SSH key configuration per VM
