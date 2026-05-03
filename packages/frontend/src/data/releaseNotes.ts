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
