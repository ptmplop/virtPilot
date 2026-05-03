# Changelog

All notable changes to VirtPilot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.21.3] — 2026-05-04

### Fixed

- **`bootstrap.sh` and `update.sh` still hit "dubious ownership" on hosts that already had v1.21 installed, even after the v1.21.2 fix.** The previous fix wrote `safe.directory` via `git config --global`, but under `curl … | sudo bash` the resolved `$HOME` doesn't always end up at `/root` — the config write lands somewhere git won't read back from. Both scripts now pass `safe.directory` inline via `git -c safe.directory=…` on every invocation, which is immune to whichever `.gitconfig` HOME ends up resolving to. They also try a best-effort `git config --system --add safe.directory` (writes to `/etc/gitconfig` so future tooling still benefits) but no longer depend on it.

## [1.21.2] — 2026-05-03

### Fixed

- **`bootstrap.sh` and `update.sh` failed with "fatal: detected dubious ownership in repository" on any host that had already run the v1.21 installer.** The new `install.sh` chowns `/usr/local/virtpilot` to the unprivileged `virtpilot` service user, but bootstrap and update both run git as root, which then refuses to operate on a non-root-owned tree. Both scripts (and `install.sh` itself) now `git config --global --add safe.directory ${INSTALL_DIR}` before any git operation, so the whitelist entry is persisted in root's gitconfig and subsequent runs work without manual intervention. Idempotent — git de-duplicates the entry.

## [1.21.1] — 2026-05-03

### Fixed

- **`install.sh` aborted with `BACKEND_PORT: unbound variable` right after hashing the password.** The .env heredoc references `${BACKEND_PORT}` and `${PUBLIC_PORT}` in a comment to explain the no-nginx fallback, but those variables were declared in the nginx section *after* the .env was written. Combined with `set -euo pipefail`, this killed the install on the very next step. Both ports are now declared at the top of the script with the other constants so they're in scope wherever they're referenced.

## [1.21.0] — 2026-05-03

### Security

This release lands a comprehensive security hardening pass — every Critical and High finding from the public-IP review is addressed. After upgrade you must re-enter your login password (the legacy plaintext is migrated to a hash on first login) and existing 2FA secrets are silently re-encrypted on the next settings save.

- **Backend now runs as the unprivileged `virtpilot` system user, not root.** `install.sh` creates a dedicated `virtpilot` account, grants it `libvirt`/`kvm`/`systemd-journal` group membership and `CAP_NET_ADMIN`/`CAP_NET_RAW` ambient capabilities so it can drive iptables/ip without sudo, and sandboxes the systemd unit with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `ProtectKernelTunables`, `ProtectKernelModules`, `RestrictSUIDSGID` and friends. The handful of operations that still need root (`systemctl`, `systemd-run`, `apt-get upgrade`, `bash update.sh`) go through a tightly-scoped `/etc/sudoers.d/virtpilot` allow-list. Any future RCE in the backend now lands in a sandbox with no setuid execs, no kernel writes, no file-system writes outside `/var/lib/virtpilot` and the install dir.
- **Login password is hashed with scrypt at install time and verified with `crypto.timingSafeEqual()`.** `install.sh` runs the password through Node's built-in scrypt before writing it to `.env`, so the file no longer carries plaintext credentials. The runtime accepts both `AUTH_PASSWORD_HASH` (preferred) and the legacy plaintext `AUTH_PASSWORD` for backwards compatibility — the first successful login on an upgraded install rewrites `.env` to swap in the hash and remove the plaintext line.
- **Brute-force-resistant auth.** New in-memory rate limiter caps `/api/auth/login` and `/api/auth/verify-totp` at 5/10 attempts per 15 minutes per IP, then a 15-minute lockout. Successful auth resets the bucket. TOTP codes are also tracked in a small replay-protection map so the same 6-digit code can't be submitted twice inside its 90-second tolerance window.
- **Logout actually revokes the JWT.** Previously a leaked token was usable for the full 24-hour TTL; the new `/api/auth/logout` endpoint adds the bearer token to a server-side revocation list that `requireAuth` and the WebSocket upgrade handler both consult. The frontend's logout flow now calls this endpoint before clearing local state.
- **WebSocket auth moves out of the URL.** The console, SSH and VNC WS endpoints no longer accept `?token=…` — the frontend offers the JWT via `Sec-WebSocket-Protocol: virtpilot.token.<jwt>` and the backend negotiates that subprotocol back. Tokens no longer end up in nginx access logs, journalctl, or browser history. The two SSE endpoints (apt upgrade, virtpilot self-upgrade) similarly switched from `EventSource` (header-less) to `fetch` + `ReadableStream` so the JWT rides in the `Authorization` header. Each WebSocket also gets a `maxPayload` limit (1 MiB for console/SSH, 8 MiB for VNC) so a malicious peer can't memory-exhaust the host with one giant frame.
- **Pervasive command-injection elimination.** Every shell-out (`virsh`, `iptables`, `ip`, `qemu-img`, `genisoimage`, `apt`, `git`, `systemctl`, `systemd-run`, `journalctl`, …) now goes through a single `safeExec.run()` helper that uses `execFile` with array arguments — no more `exec()` with concatenated strings. A new `lib/validate.ts` module gates VM names, network names, snapshot names, MACs, IPs, CIDRs, ports, port ranges, ICMP types, disk targets, NIC names, bridge names and filenames at every public boundary, throwing `ValidationError` on anything that doesn't match the strict regex. Cloud-init `meta-data`/`user-data`/`network-config` are now rebuilt with explicit YAML quoting and per-field validation, so a hostname like `foo\nuser: root` can't inject extra cloud-config keys, and SSH key text containing newlines can't append `command="…"` lines to `authorized_keys`.
- **SSRF guard on URL-driven downloads.** The "download ISO/template from URL" endpoints now reject anything that isn't `http`/`https`, anything resolving to RFC1918/loopback/link-local/CGNAT/IPv6 ULA addresses or to `localhost`/`169.254.169.254`/`::1`, with a maximum of 5 redirects each re-validated. An authenticated user can no longer point the downloader at the AWS metadata service, internal Redis, `file:///etc/shadow`, or arbitrary internal LAN hosts. Operators on private mirrors can opt out with `ALLOW_PRIVATE_DOWNLOAD=1`.
- **Path-traversal hardening on uploads, deletes, archives, and backup restore.** `multer` upload handling for ISOs and templates now `path.basename()`s `originalname` before joining and re-validates against a strict allow-list, so `filename="../../etc/cron.d/x"` collapses to a leaf name. The tar.gz ISO extractor rejects entries with absolute paths or `..` components (zip-slip). `DELETE /api/isos/:filename` and `DELETE /api/templates/:filename` re-validate the path parameter. `restoreBackup` strips directory components from manifest disk filenames so a tampered backup tarball can't write outside the VM directory.
- **Per-bucket WebSocket subprotocol auth + CORS allow-list + CSP restored.** Helmet's CSP is back on with a same-origin script-src and a tight directive set; CORS now defaults to same-origin only (set `ALLOWED_ORIGINS=https://example.com` for cross-origin frontends) instead of `origin: true, credentials: true`.
- **TOTP secrets and VM passwords encrypted at rest.** `lib/secretsCrypto.ts` provides AES-256-GCM with a key derived from the new `ENCRYPTION_KEY` env var (auto-generated by `install.sh`); legacy plaintext values pass through transparently and are re-encrypted on the next save. `vm-metadata.json` and `user-settings.json` are also written with mode 0600.
- **Self-upgrade requires TOTP step-up when 2FA is enabled, and is rate-limited to one attempt per 5 minutes.** A stolen JWT can no longer push a malicious tag through the in-dashboard self-upgrade path without also stealing the user's authenticator code.
- **Default bind address is now `127.0.0.1`, not `0.0.0.0`.** Operators put nginx/Caddy in front of port 3001 with a real cert; running directly on a public IP requires explicit opt-in via `BIND_ADDRESS=0.0.0.0` in `.env`. The TLS cert generator also stops using `CN=test` — it picks the actual hostname (or, if that's empty, the primary IP).
- **Bootstrap pins to the latest release tag by default.** `bootstrap.sh` now resolves the latest GitHub release tag and checks that ref out instead of tracking `main`, so a compromise of `main` doesn't auto-deploy to every fresh install. Override with `VP_REF=main` for development checkouts or `VP_REF=v1.20.0` for a specific version.
- **`npm ci` instead of `npm install` during install/update**, so the lockfile is treated as authoritative — refuses to install if `package.json` and `package-lock.json` disagree (defends against tampered npm registry mirrors). `update.sh` now also runs npm as the `virtpilot` user instead of root.

### Added

- **Optional nginx reverse proxy bundled with `install.sh`.** Default-yes prompt offers to install nginx in front of the backend: nginx listens on the existing public port (3001) with the self-signed cert, the Node backend moves to `127.0.0.1:3002` and speaks plain HTTP. Same URL the operator already uses (`https://host:3001`), but TLS termination, request logging, large-file uploads (`client_max_body_size 100G`), WebSocket upgrades for `/ws/*`, and SSE-friendly `proxy_buffering off` all live at the edge instead of in Node. Ports 80 and 443 are intentionally not touched. Skip with `VP_NGINX=no` for unattended installs; if you skip, the backend keeps binding to `0.0.0.0:3001` directly with its own TLS (same as before this release). UFW (when active) is updated to allow `:3001` and deny `:3002`. `update.sh` migrates pre-1.21 `.env` files: existing nginx site → backend pinned to `127.0.0.1:3002` HTTP; no nginx → `BIND_ADDRESS=0.0.0.0` is added to keep the dashboard reachable.

## [1.20.1] — 2026-05-03

### Changed
- **Installer hard-fails on unsupported architectures and OS versions instead of warning and pressing on.** Previously `install.sh` only soft-warned ("This installer targets Ubuntu 24. Proceeding on unrecognised OS...") and there was no architecture check at all, so running on arm64 or on Debian/RHEL would proceed past the pre-flight, install Node.js from the NodeSource amd64 repo, and then fail later in the build step with an unhelpful npm error. The check is now strict: `uname -m` must be `x86_64` and `/etc/os-release` must report `ID=ubuntu` and `VERSION_ID=24.04`, otherwise the script dies immediately with a clear "Unsupported … VirtPilot supports Ubuntu 24.04 only" message. Same checks added at the very top of `bootstrap.sh` so the curl-pipe one-liner fails fast before installing git or doing the clone.
- **Removed the duplicate ASCII banner when running via the `curl … | sudo bash` bootstrap.** `bootstrap.sh` printed the banner and then exec'd `install.sh`, which printed the same banner immediately afterwards. The banner now only appears once (from `install.sh`); `bootstrap.sh` keeps a single-line "VirtPilot — Bootstrap" header.

## [1.20.0] — 2026-05-03

### Added
- **HTTPS by default with a self-signed TLS certificate.** VirtPilot now serves the web UI and all WebSocket traffic (console, SSH, VNC) over TLS instead of plain HTTP. The installer generates a 10-year self-signed certificate at `${STORAGE_ROOT}/tls/{cert,key}.pem` with `subjectAltName` covering the host's hostname, `localhost`, the primary IP, and `127.0.0.1`, then the backend serves on the same port (3001) using HTTPS. Existing installs migrate automatically: `update.sh` runs the same idempotent cert generation and only creates files when they're missing, so a single `update.sh` (or in-dashboard self-upgrade) flips an existing host onto HTTPS without manual intervention. The browser will warn about the self-signed cert on first visit — click "Advanced → Proceed" once and the warning is dismissed for that host. Old `http://host:3001` bookmarks need to be updated to `https://`. The backend still falls back to plain HTTP if no cert files are present, so the dev workflow (`npx tsx src/index.ts` against a fresh checkout) keeps working without certs.

## [1.19.11] — 2026-05-03

### Fixed
- **`install.sh` no longer drops out silently at the password prompt when run via the `curl … | sudo bash` bootstrap.** The installer used `read -rsp` against stdin, but stdin in that flow is the curl pipe — already EOF by the time the prompt runs. Combined with `set -euo pipefail`, `read` returned non-zero and the script exited immediately after printing "Set a login password for the VirtPilot web UI:" with no further output. The password reads now go to `/dev/tty` directly so the prompt works regardless of how stdin was wired up. Also added a `VP_PASSWORD` env var override for fully unattended installs (`VP_PASSWORD=secret sudo -E bash install.sh`), and a clear error if neither a TTY nor `VP_PASSWORD` is available instead of failing silently.

## [1.19.10] — 2026-05-03

### Changed
- **Dashboard's Host Metrics section is now collapsible.** The four full-width charts (CPU, Memory, Disk I/O, Network) take up a lot of vertical space, which is wasted when you've come to the dashboard for the Overview tiles or to check System Updates. Click the "Host Metrics" header (or its chevron) to fold the whole block away — the Live/1h/24h range toggle is hidden alongside the charts so the collapsed header sits clean. State persists in `localStorage` under `virtpilotHostMetricsCollapsed` so the preference survives reload.

## [1.19.9] — 2026-05-03

### Added
- **Storage page now lets you delete orphaned VM folders.** When a VM is deleted with "keep storage", or when libvirt loses track of one (e.g. a manual `virsh undefine`), the qcow2 disks under `$STORAGE_ROOT/vms/<name>/` had no UI to remove them — they could only be cleaned by SSHing in and `rm -rf`-ing the directory by hand. The Storage page already flagged these rows with an "orphaned" badge; it now also shows a trash button on those rows (and only those rows). Confirming runs a new `DELETE /api/vms/disks/:vmName` that recursively removes the VM directory and any leftover cloud-init scaffolding (`seed.iso`, `domain.xml`, per-VM cloud-init dir). The endpoint refuses if libvirt still has a domain by that name, so it can't wipe storage out from under a defined VM.

### Fixed
- **"Essential cloud images" card now only appears when the templates library is genuinely empty, and re-appears if you later empty it.** The card was gated on "any starter image is missing on disk", so a user who'd uploaded their own qcow2 still saw it whenever they were missing one of the starter set entries. It's now gated on `templates.length === 0`. Additionally, the persistent `templateSetDismissed` flag was sticky forever once set — meaning a user who dismissed the card on day 1 would never see it again, even after wiping every template on day 100. The flag now auto-clears whenever the templates list is non-empty, so dismissal effectively means "hide for this empty state" rather than "hide forever".

## [1.19.8] — 2026-05-03

### Removed
- **CentOS Stream 10 dropped from the starter template set.** Confirmed on the production host that booting the GenericCloud image under VirtPilot's UEFI VMs drops to the EDK II UEFI shell — the qcow2 has only `1.0M BIOS-boot + 7.8G root` (GPT, no EFI System Partition), so OVMF can't find a bootloader. Inspected the older Stream 9 image and the newer `…-x86_64-…` 10 build too; both ship with the same BIOS-only layout, and the cloud SIG only publishes BIOS-style images (the EC2 `.raw.xz` variants are also BIOS). No URL fix is possible — for a CentOS-equivalent UEFI cloud image you want AlmaLinux 9 (already in the set) or AlmaLinux 10 (`1.0M + 200M ESP + 1.0G boot + 8.8G root`). Removed the entry rather than swap it for an Alma 10 entry under a misleading "centos" label. Existing installs that already downloaded `centos-stream-10.qcow2` can delete it from `$STORAGE_ROOT/templates/`; any VMs created from it can't be salvaged (they never reached a kernel) and need to be recreated from a working template.

## [1.19.7] — 2026-05-03

### Fixed
- **Cloud-init now uses `/bin/sh` for the default user so SSH works on Alpine.** v1.19.6 fixed Alpine's BIOS/UEFI mismatch and the VM booted, but SSH still rejected every attempt with `Permission denied (publickey,password,keyboard-interactive)`. The auth log on the guest had the actual reason: `User virtpilot not allowed because shell /bin/bash does not exist`. The cloud-init template hardcoded `shell: /bin/bash`, which doesn't exist on Alpine — sshd refuses login for any user whose shell is missing, regardless of how good the keys or password are. Switched the user shell to `/bin/sh` (the only shell guaranteed to exist on every distro) and added a `runcmd` that does `chsh -s "$(command -v bash)" virtpilot` on systems where bash is installed, so interactive shells on Ubuntu/Debian/RHEL/Alma/Rocky/Fedora/openSUSE still get bash. Only affects newly-created VMs; existing Alpine VMs need their `virtpilot` shell updated by hand (`vipw`/`usermod`) or to be recreated.

## [1.19.6] — 2026-05-03

### Fixed
- **Alpine 3.21 starter template now boots.** The pinned URL was the BIOS-only artifact (`nocloud_alpine-3.21.0-x86_64-bios-cloudinit-r0.qcow2`), which writes SYSLINUX into the MBR of an unpartitioned ext4 disk — no GPT, no EFI System Partition. VirtPilot defines every VM with `<os firmware='efi'>` (OVMF/UEFI), and OVMF can't chain a SYSLINUX MBR, so guests stayed in the firmware boot manager forever — `virsh dominfo` reported `running` while the VM never reached a kernel. Confirmed on the production host: a `test3` VM created from this template sat in this state with no errors in `/var/log/libvirt/qemu/test3.log`. Switched the URL to the UEFI variant (`nocloud_alpine-3.21.7-x86_64-uefi-cloudinit-r0.qcow2`, also bumped to the latest 3.21 patch). Existing installs need to delete the old `alpine-3.21.qcow2` from `$STORAGE_ROOT/templates/` and re-download (the bulk card will resurface once it's gone); any VMs already created from the bad template must be recreated, since their `disk.qcow2` overlays the broken backing image.

## [1.19.5] — 2026-05-03

### Added
- **QEMU and kernel version are now shown on the dashboard's host identity card.** The Host zone (under hostname and CPU specs) now lists the QEMU version (parsed from `qemu-system-x86_64 --version`) and the kernel version (`uname -r`) so you can see at a glance which hypervisor/kernel build is in use without dropping to a shell. Both are surfaced via `/api/system/info`; QEMU falls back to `unknown` if `qemu-system-x86_64` isn't on PATH.

## [1.19.4] — 2026-05-03

### Fixed
- **CentOS Stream 10 download was being silently rejected with HTTP 403 because the backend sent no User-Agent header.** A v1.19.3 production run finished 7 of 9 — the two failures (CentOS Stream 10 and Fedora 41) both retried 3× and 3× hit the same status code, ruling out transient causes. With backend logging in place we caught the actual error: `cloud.centos.org` rejects requests with no User-Agent header. Verified by `curl -H "User-Agent:"` from the production host: 403 every time. With curl's default UA: 200 every time. Node's `http.get` doesn't send a User-Agent by default. Backend now sets `User-Agent: VirtPilot/1.19.4 (+https://github.com/ptmplop/virtPilot)` on every outbound `streamUrl` request — fixes CentOS instantly, identifies us in mirror access logs for traceability, and is generally good citizenship.
- **Fedora 41 download was 404'ing because the redirector geo-routes US clients to a mirror that doesn't carry Fedora.** `download.fedoraproject.org` redirected the production host to `ftp-chi.osuosl.org`, which forwarded to `ftp2.osuosl.org/pub/fedora/...` — a path that returns 404 because OSU OSL's actual Fedora mirror lives at `fedora.osuosl.org` (different subdomain). The redirector is sticky per client IP, so retries hit the same broken mirror every time (5/5 probes from the host). I tested several other US mirrors directly (`mirror.facebook.net`, `mirrors.kernel.org`, `mirror.fcix.net`, `mirror.us-midwest-1.nexcess.net`) — all 404 too, suggesting Fedora 41 simply hasn't propagated to most US mirrors yet. EU mirrors all carry it. Pinned the URL to `gemmei.ftp.acc.umu.se` (Umeå University, Sweden — long-running academic mirror) to bypass the redirector entirely.

## [1.19.3] — 2026-05-03

### Fixed
- **Starter template-set bulk now retries transient failures and surfaces the failure reason.** A v1.19.2 production run completed with 5 of 9 templates downloaded; the 4 that failed (Debian 13, CentOS Stream 10, openSUSE Leap 15.6, Fedora 41) all returned HTTP 200 from the same host moments later, so the failures were transient — most likely a brief network blip or the Fedora redirector pointing at a half-broken mirror (`download.fedoraproject.org` round-robins across mirrors, ~1 in 5 served a 404 in repeated probes). Added bounded retries: each item now gets up to 3 attempts with a 5s backoff before being marked failed, which masks the most common transient causes. Cancelled runs short-circuit retries immediately.
- **Failure summary toast now sticky and itemised.** The previous "Starter set partial — 5 done, 4 failed" toast vanished after 3.5s with no breakdown of which items failed or why — easy to miss while on another tab. Now the partial/failure toast persists until the user dismisses it and lists each failed item with the backend's error reason (e.g. `Debian 13 Trixie: HTTP 503`, `Fedora 41 Cloud: Upstream stalled — no bytes for 60s`). Backend's `job.error` field is now surfaced through the polling response into the orchestrator instead of being discarded.
- **Card resurfaces when any starter-set item is missing.** Previously the card hid as soon as any template existed, so a partial run left no obvious retry path — the user had to delete the existing templates to get the card back. Now the card is visible whenever any item from `TEMPLATE_SET.templates` is not on disk (and the user hasn't dismissed it). Clicking Download starter set runs the orchestrator, which dedupe-skips already-present files and only re-downloads the missing ones, so retrying a partial run is a single click.

### Changed
- **Backend now logs each template download's start/done/error to stderr** (visible via `journalctl -u virtpilot`). Lines look like `[template-download] start jobId=… file=… url=…` / `done jobId=… bytes=… duration=…s` / `error jobId=… err=…`. Without this, prior-release failures left no trail and were impossible to diagnose without re-running the bulk.
- **`streamUrl` enforces an idle-stall timeout (60s after the last byte) and a headers timeout (30s)**. Previously a mirror that opened a connection then went silent would hang the orchestrator forever — the new timeouts surface as `Upstream stalled — no bytes for 60s` / `Upstream did not send headers within 30s` so the per-item retry can take over.

## [1.19.2] — 2026-05-03

### Fixed
- **Starter template-set bulk download now resumes after a full page reload, tab close, or browser restart.** The v1.19.1 fix moved bulk state into a Zustand store, which survived in-app SPA navigation, but the store was in-memory only — a hard reload, F5, or closing the tab wiped both the store and the orchestration loop with no way to recover, and the user just saw the run silently halt halfway through. Live repro: Rocky 9 + AlmaLinux 9 finished, page got reloaded for unrelated reasons, items 3–9 never even POSTed because the orchestrator was gone. Fixed by adding zustand `persist` middleware to `uploadProgressStore` (with `partialize` so only `templateBulk` is persisted to localStorage — abort callbacks and per-job progress stay transient), refactoring `lib/templateSetDownloader.ts` to support resume-from-index, and wiring `resumeTemplateSetDownloadIfNeeded()` into `ProtectedRoute` so any unfinished run picks back up the moment an authenticated route mounts.
- **Resume is dedupe-safe.** Before kicking off the loop the orchestrator now snapshots the current templates list and skips any item whose filename is already on disk (counted as succeeded). Covers two real cases: (1) the resumed item actually finished downloading right before the page died but the state-write was lost, and (2) the user has manually uploaded a file with the same filename. Avoids re-downloading a 600 MB qcow2 the user already has.
- **Single-instance guard.** A module-level `orchestratorRunning` flag prevents `resumeTemplateSetDownloadIfNeeded()` (firing on `ProtectedRoute` mount) from racing with a fresh "Download starter set" click — second caller is a no-op rather than spawning a parallel loop that would double-count succeeded/failed totals and fight over the same backend job ids.

## [1.19.1] — 2026-05-03

### Fixed
- **Starter template-set bulk download now survives page navigation.** Previously the orchestration loop and its progress state lived inside the `TemplatesPage` component — clicking "Download starter set" and then navigating to e.g. the VMs page caused `setBulk(...)` calls to write to a destroyed setter and the progress card to vanish on return, even though the backend was technically still serving the in-flight item. Worse, on remount the local cancel flag (a `useRef`) was reset to `false`, so there was no way to stop the run from outside the original mount. Fixed by mirroring the pattern used for single-template/single-ISO downloads: bulk state (`templateBulk`, `templateBulkCancelled`) hoisted into `uploadProgressStore`, and the orchestration loop moved into `lib/templateSetDownloader.ts` as a module-level function that reads/writes the store directly. The loop now keeps progressing through all nine images regardless of which page the user is on, the card re-renders the live progress on remount, and Cancel still works because the flag lives in the store. Side benefit: kicking off the same run twice (e.g. by clicking Download on remount) is a no-op rather than starting a parallel run.

## [1.19.0] — 2026-05-03

### Added
- **Starter template-set card on the Templates page.** A fresh install with no qcow2 templates yet now sees a one-click "Download starter set" card above the (empty) templates table. It pulls a curated list of nine common amd64 cloud images (Rocky Linux 9, AlmaLinux 9, Ubuntu 24.04 Noble, Debian 13 Trixie, CentOS Stream 10, openSUSE Leap 15.6, Fedora 41, Alpine 3.21, Arch rolling) sequentially in the background, reusing the existing `/api/templates/download` job system — one image at a time so the user can keep working. Per-file progress bar plus a "3 of 9" counter and a running succeeded/failed tally on the card itself; cancelling aborts the in-flight job and skips the rest. Each entry brings its OS logo with it so logos are pre-assigned the moment the file lands. The card has an explicit dismiss `×` for users who want to manage their own templates from scratch.
- **Card auto-resurrects on empty.** `DELETE /api/templates/:filename` now checks whether the directory is empty after the delete and clears `templateSetDismissed` if so, so wiping every template brings the starter card back without the user having to dig into settings. The frontend invalidates the settings query alongside the templates query on delete so the card reappears without a reload.
- **Configurable starter set.** The list lives in `packages/frontend/src/data/templateSets.ts` (a TypeScript constant, not a backend file) — edit the array, rebuild the frontend, ship a new release. Each entry is `{ url, filename, name, logo }`; `logo` slugs come from `src/lib/osLogos.ts`. All bundled URLs were validated against their upstream mirrors (HTTP 200) before inclusion. Dead links at runtime are caught by the existing fast-fail in `streamUrl` (the `.part` file isn't even allocated until the upstream returns 200) and counted as a per-item failure rather than aborting the whole set.

### Changed
- **`POST /api/templates/download` accepts more file extensions without auto-renaming.** The filename-extension guard now allows `.qcow2`, `.img`, `.raw`, `.iso`, and `.iso.gz`; previously anything outside `.qcow2|.img` got `.qcow2` silently appended. Affects both the manual "From URL" download dialog and the new starter-set flow — installer ISOs and raw disk images now land with their real extension instead of being mangled to `foo.iso.gz.qcow2`.
- **`UserSettings.templateSetDismissed` (boolean, default `false`)** added to `$STORAGE_ROOT/user-settings.json` and exposed via `GET/PUT /api/settings`. The Templates page reads it to decide whether to render the starter card; the dismiss button on the card writes `true`.

## [1.18.2] — 2026-05-03

### Fixed
- **Cloud-init network-config now applies on RHEL-family guests (AlmaLinux/Rocky/CentOS).** Default routes were emitted as `to: default`, which is a netplan shorthand. Debian/Ubuntu cloud-init forwards network-config straight to the `netplan` binary, which understands it; RHEL-family cloud-init parses v2 internally via `cloudinit.net.network_state` and that parser blew up with `ValueError: Address default is not a valid ip address`, aborting the whole network apply. Result: a freshly-created Alma 10 VM came up with `eth0` link-up but no IPv4 — the host then got `EHOSTUNREACH` when the in-dashboard SSH console tried to reach the configured static IP. Fixed by emitting the spec-conformant `to: 0.0.0.0/0` instead.
- **Cloud-init `ssh_authorized_keys` now actually nests under the user.** The keys list was indented at 2 spaces but `ssh_authorized_keys:` lives at 4 spaces inside the `- name:` user dict, so the keys were parsed as sibling list items in `users:` rather than as the user's keys. YAML-valid but semantically wrong: cloud-init's `users_groups` module failed schema validation, no SSH keys were ever installed on any VM, and the `lock_passwd: false` directive was dropped along with the rest of the user dict (visible as `Not unlocking password for user X. 'lock_passwd: false' present... but no 'passwd'/...'hashed_passwd' provided` in `cloud-init-output.log`). Bumped indent to 6 spaces. **Existing VMs are unaffected at runtime** — they were already provisioned with the broken seed and won't re-run cloud-init — but every new VM created after this release gets working key auth.

## [1.18.1] — 2026-05-03

### Changed
- **Default cloud-init username is now `virtpilot`** (previously `ubuntu`). The username field on the VM Create form is pre-filled with `virtpilot` instead of `ubuntu`, so newly-created VMs get an SSH login of `virtpilot@<ip>` by default. The field is still editable on a per-VM basis. Existing VMs are unaffected — their username is persisted in `vmMetaService` storage and inside the seed.iso, so they keep working as before. Only the form default changed; the cloud-init template itself was already parameterised, and the SSH WebSocket proxy reads `username` from VM metadata (so existing `ubuntu`-user VMs continue to connect correctly).

## [1.18.0] — 2026-05-03

### Fixed
- **24h metrics charts (host and per-VM) actually bucket.** The 5-minute aggregation SQL in `systemMetricsService.ts` and `vmMetricsService.ts` was `(ts / ?) * ? AS bucket_ts` with the bucket size bound as a JS Number, which `better-sqlite3` passes through as `REAL`. SQLite then evaluated the division in real-number mode, so the expression returned the original `ts` unchanged and every raw 30-second sample got its own `bucket_ts` — `GROUP BY bucket_ts` was effectively a no-op. Result: ~2880 points per chart instead of ~288, and the 24h range was effectively the same data as 1h until the table accumulated more than an hour's worth of rows. Casting to INTEGER inside the division (`(CAST(ts/? AS INTEGER)) * ?`) forces the floor we want.
- **VM delete now cleans up after itself.** Two related leaks:
  - `DELETE /api/vms/:name?deleteStorage` defaults to `true` so the qcow2 disk dir is removed by default — previously the default was `false` and recreating a VM with the same name 409-d with `Storage directory for "{name}" already exists. Remove ... manually before retrying.` The old behaviour is still available via `?deleteStorage=false`.
  - Cloud-init artefacts (`{cloudInitDir}/{name}/`, `{cloudInitDir}/{name}-seed.iso`, `{cloudInitDir}/{name}-domain.xml`) are now removed unconditionally on delete via a new `deleteCloudInitArtifacts()` helper in `cloudInitService.ts`. They're VirtPilot-internal scaffolding and were never user data, but the previous delete left them behind and they accumulated as zombies for every test VM ever created (existing zombie files from prior installs are not auto-cleaned — `rm -rf` them manually if desired).
- **IP allowlist input validation actually validates.** The previous `isValidIpEntry` accepted `999.999.999.999` (regex didn't enforce 0–255 octets) and treated any string containing `:` as IPv6. Now both forms are checked properly: octet ranges for IPv4, RFC-4291-shaped groups + correct `::` compression handling for IPv6, optional CIDR prefix bounds (0–32 v4, 0–128 v6), and IPv4-mapped forms like `::ffff:1.2.3.4`.
- **Self-lockout guard on `PUT /api/settings`.** If a non-empty `ipWhitelist` is being applied that would exclude the caller's own IP, the request 400s with `Refusing to apply allowlist that excludes your own IP (X). Add it to the list first or empty the list to disable IP filtering.` Previously the file was written and the user's next request (including the redirect after the PUT) would 403 from the auth middleware.
- **SSH-key add now rejects malformed keys.** `POST /api/ssh-keys` previously returned 201 OK for `publicKey: "this is not a key"` — the bad key would later silently fail in cloud-init on the guest with no signal at the dashboard layer. New validation gates on the well-known OpenSSH type prefix (`ssh-rsa`, `ssh-dss`, `ssh-ed25519`, `ssh-ed448`, `ecdsa-sha2-nistp{256,384,521}`, `sk-*@openssh.com`) and a `[A-Za-z0-9+/]={0,2}` base64 charset check on the blob.
- **Boot-order PUT now rejects unknown disk targets.** Previously sending logical names like `["hd","cdrom"]` to `PUT /api/vms/:name/boot-order` returned 200 OK but silently no-op-ed (the underlying XML rewrite only matches existing `<target dev="...">` entries), so the GET kept returning `[]` after a "successful" PUT. Now the route looks up the VM's actual disk targets and returns `400 Unknown disk targets in bootOrder: hd, cdrom. Valid targets are: vda, sda, sdb`.
- **Snapshot delete after a revert produces an actionable error.** The chain-divergence check used to recommend *"a newer snapshot exists. Delete newer snapshots first"* even when there were no newer snapshots — only the `*-revert-*.qcow2` overlay sitting on top. The error now detects the revert-overlay shape and points the user at the new `?metadataOnly=true` escape hatch.

### Added
- **`DELETE /api/vms/:name/snapshots/:snapshot?metadataOnly=true`** drops just the libvirt snapshot record without trying to merge the overlay back into its backing — the escape hatch for VMs whose disk chain has diverged from the snapshot (e.g. after a revert). The overlay file itself stays on disk; flatten it manually with `qemu-img commit` if you want the storage back.
- **`POST /api/vms/:name/stop` and `/reboot`** now accept `force` from either the JSON body (`{"force": true}`) or the query string (`?force=true`). Previously only the query string was read and bodies were silently ignored, which doesn't match the rest of the API.
- **Backup summaries (`GET /api/backups`)** now include a `vmExists: boolean` per row, so the UI can mark orphan summaries (backup metadata for a VM that has been deleted) and offer a purge action. Existing zombie summaries on this host: `eufi`, `seabios` (and historically `test`) — they all still show up, but are now marked as detached.

## [1.17.2] — 2026-05-03

### Fixed
- **`update.sh` build failure: `siProxmox` declared but its value is never read.** The v1.16.0 OS-logo expansion imported `siProxmox` from `simple-icons` with the intention of including Proxmox in the appliance category, but the entry never made it into the `SPECS` array. The frontend's `npm run build` runs `tsc -b` which respects `tsconfig.app.json`'s `noUnusedLocals: true`, so the build aborted with `error TS6133`. The frontend's standalone `npm run typecheck` (which runs `tsc --noEmit` against the project-references stub `tsconfig.json`) silently passed because the stub config doesn't include source files. Proxmox is now included in the appliance category as originally intended, so the icon shows up in the Templates/ISOs picker

### Added
- **Proxmox** (`siProxmox`) added to the OS-logo picker under the Appliances section — restored from the v1.16.0 intent. Useful for tagging nested-Proxmox lab VMs

## [1.17.1] — 2026-05-03

### Fixed
- **Self-update modal no longer hangs on "Restarting service…".** The polling loop that waits for the new backend to come back up listed `invalidateVersion` (returned by `useInvalidateVersion()`) in its `useEffect` dependency array. The hook returned a fresh function reference on every render, so every 2 s — when the dashboard re-rendered because of `useSystemStats` polling — the effect re-ran: the previous polling tick was cancelled mid-flight, and the 90 s timeout deadline was reset. Result: success was never registered (because every fetch's resolution found `cancelled === true`) and the timeout never fired (because the deadline kept moving). Existing stuck modals can be unstuck by reloading the page; the new backend was already running. Two fixes applied: (1) `useInvalidateVersion` and `useInvalidateApt` are now wrapped in `useCallback` so they return stable refs across renders, and (2) the redundant `invalidateVersion()` call right before `window.location.reload()` was removed — the reload throws away the React Query cache anyway, so cache invalidation immediately before is unnecessary, and dropping it lets the polling effect avoid depending on the hook entirely

## [1.17.0] — 2026-05-03

### Changed
- **Dashboard "Live Metrics" section restyled to match the per-VM Metrics tab.** Renamed to "Host Metrics" and given a Live / 1h / 24h range selector in the section header. The 2×2 grid of cards (each with a sparkline area chart) is replaced by a single column of full-width cards stacked one per row — CPU Usage, Memory, Disk I/O, Network. Each chart now uses the same `MetricChart` component as the per-VM tab: labelled Y axis (0/25/50/75/100 % for CPU and Memory; auto-scaled byte values for Disk and Network), labelled X axis with timestamps (`HH:MM:SS` for Live, `HH:MM` for 1h, `DD/MM HH:MM` for 24h), dashed horizontal grid lines, and a "nice" round Y-max so small spikes don't flatten the baseline. Card chrome (coloured top stripe, glowing icon badge, accent typography) is preserved
- **Live mode still draws from the in-memory 2-second sampler** (60 samples, ~2 minutes), so the existing live tile refresh cadence is unchanged. Switching to 1h or 24h reads from the new persistent store

### Added
- **Persistent host metrics storage.** A new SQLite table `system_metrics` (migration v2) records one host sample every 30 s with the same fields as the per-VM table — CPU %, memory used/total, disk read/write Bps, network RX/TX Bps. 24-hour retention, pruned in the same loop. Persistence is wired into the existing 2-second `statsService.takeSample()` and gated by a 30 s minimum interval, so no new sampler runs
- **`GET /api/system/metrics?range=1h|24h`** endpoint. Returns `{ range, history }` mirroring the per-VM `/api/vms/:name/metrics` shape. `1h` returns raw 30 s points; `24h` aggregates into 5-minute buckets via `AVG()` so the chart stays at ~288 points

### Removed
- **`AreaChart` component deleted.** It was only used by the dashboard's old chart-bearing card; the per-VM Metrics tab already uses `MetricChart`. Now everything goes through `MetricChart`

## [1.16.0] — 2026-05-03

### Added
- **Bigger OS-logo selection on the Templates and ISOs pages.** The picker grew from 17 entries to 43, organised into Linux / BSD / Privacy & Security / Appliances / Other sections. New Linux distributions: Red Hat, SUSE, Pop!_OS, elementary OS, Zorin OS, Artix Linux, EndeavourOS, Garuda Linux, Void Linux, Deepin, Solus, generic Linux (Tux). New BSDs: OpenBSD, NetBSD. Privacy: Qubes OS, Tails. Turnkey appliances commonly run as KVM guests: pfSense, OPNsense, OpenWrt, MikroTik RouterOS, TrueNAS, openmediavault, Home Assistant, Pi-hole, AdGuard, Talos Linux. All icons ship in the existing `simple-icons` dependency — no new packages, no runtime download
- **Search box and category headings in the OS-logo picker.** With 43 entries the flat grid was getting tall, so the dropdown now opens with a focused search input at the top and groups the results under section headings. The picker body is scrollable (max-h ≈ 320 px) and shows a "No logos match …" placeholder when the query has no hits
- **Dark-brand logos render readably in both themes.** Brand colours below a luminance threshold (pfSense `#212121`, MikroTik `#293239`, SUSE `#0C322C`, …) used to vanish against the existing brand-tinted tile. Tiles for those logos now use `bg-foreground/10` and render the icon in the foreground colour, so they're visible on both light and dark cards. Logos with bright brand colours are unchanged

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
