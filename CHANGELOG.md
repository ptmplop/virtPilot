# Changelog

All notable changes to VirtPilot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.13.0] — 2026-10-18

### Changed

- **Phones get a real layout.** Below 768 px the sidebar becomes a drawer behind a menu button in a slim top bar, pages run edge to edge, wide tables scroll inside their own panel, and the VM list keeps each machine's name and state — tap a row for everything else. Fields no longer make an iPhone zoom in when you type.

- **A VM's Overview reads the machine while it runs.** CPU, memory, disk and network as they are now, with what the VM was given underneath; a stopped VM still shows its allocation. The Metrics tab opens straight on its history. The VM's page also shows its operating system's mark beside its name, and the Configuration panel says when it was created and which image it was built from.

- **One power control per VM in the list.** A running VM's Reboot, Power off, Hard reset and Force off are one menu, graceful above forceful, so names are no longer cut short on smaller screens and every row's icons line up. A paused or crashed VM can now be forced off from the list and from its page — before, it offered no power control at all. A VM can also be deleted from its own page (the bin after Clone).

- **The dashboard tells one story:** the host and its VMs, the host's metrics, then one Updates section holding VirtPilot's own update and the host's packages. Hardware acceleration (KVM or TCG) is stated once, a long CPU name is no longer cut mid-word, and load above the core count reads amber, not red. A warning's sentence wraps instead of being cut off, and an idle VM's CPU sparkline sits in a quiet track instead of looking like an underline.

- **Quieter lists.** Templates, ISOs, Networks and SSH keys carry their count (and total size) in the list's own foot instead of a strip of figures above a short list. Templates and ISOs show their distro's mark, read from the file name. Network types and storage defaults are plain words, not colours that read like a status.

- **One main action per view.** On a VM's tabs, Add disk, Add NIC, Take snapshot and Add rule are ordinary buttons — the page header already has the main one. In Settings, each Save stays quiet until something in its section has changed, and every button beside a field is the field's height.

- **Calmer charts with round axes.** A faint flat wash under a single line and none under a pair, instead of gradients; byte-rate axes tick at 512 KB/s, 1 MB/s, 1.5 MB/s rather than 976.6 KB/s, 1.4 MB/s.

- **The new-VM wizard asks for the boot source first** — the one choice without a default — says what Continue is waiting for, and opens the new VM once it is created. Its template and ISO picker is the height of every other field and now works from the keyboard.

### Added

- **Settings shows the address you are connecting from**, says whether the IP allowlist includes it, and offers to add it with one click. A save the server refuses now says why, instead of "Failed to save IP whitelist".

### Fixed

- **The Disks tab showed "file" as every disk's bus.** It now reads the real bus (virtio, sata, scsi).

- **A guest that doesn't report its memory read as 100% used, in amber** — that was its allocation. It now shows the memory the host has actually given it, labelled "resident on host". (Guests with the balloon driver are unchanged.)

- **Delete snapshot, Remove NIC and Remove 2FA acted on a single click.** Each now asks first. Clearing the logs uses VirtPilot's own dialog instead of the browser's.

- **Dialogs didn't take the keyboard.** Focus stayed on the page behind them, so Tab walked through every row underneath before reaching the dialog's buttons. Focus now moves into a dialog when it opens, stays there, and returns to the button that opened it.

- **The upgrade terminals and some dialogs could be drawn inside their section of the page** rather than over the whole window, because an entrance animation left a transform behind.

- **Sizes were printed raw** — "0.18 GB", "4.0 GB", "0.0 GB" — and in a monospaced face. Every size now goes through the shared formatter and sits right-aligned in its column.

- Smaller things: an Alpine template showed a generic icon, and a VM installed from an ISO now keeps the ISO's mark; Add NIC was disabled without saying why; the template and ISO delete buttons had no tooltip; each Backups row had a History button that did what clicking the row already does; "Click to expand" spelt out what the arrow already said; and words that aren't a VM's state (Healthy, Up to date, Live, guest agent) no longer carry a status dot.

## [2.12.0] — 2026-10-09

### Changed

- **The sidebar's collapse control moved off the logo.** The logo row is now just the logo, which takes you to the Dashboard. Collapsing is done with a small round handle half way down the edge between the sidebar and the page: it appears when the pointer is over the sidebar, stays visible once the sidebar is collapsed (and on touch screens), and the `[` key toggles it. Collapsing is now one smooth motion — the labels fade and the wordmark folds into the mark, but the icons don't move.

- **The dashboard's status band says each thing once, and plainly.** A healthy host reads *Healthy*, with its name and how long it has been up; a single warning is named outright (*Software emulation — No KVM: guests run without hardware acceleration*) instead of "1 warning". The VM count is left to its gauge, and the numbers no longer count up from zero every time you open the page.

- **vCPU over-commit is shown, not alarmed.** Giving running VMs more vCPUs than the host has cores is routine on KVM, so the dashboard now reads "6 on 4 cores · 1.5×" with a mark at the host's capacity, and only turns amber at an extreme ratio. Committing more memory than the host has still warns.

- **The VM page has one main action.** Console is the primary button while a VM is running (Power on while it is stopped), and the power actions are set apart from the tools. The same grouping is used in the VM list.

- **Quieter, more precise detail throughout.** Page titles line up with the content below them; operating-system logos are one-colour marks instead of coloured tiles; figures line up in their columns and are written one way everywhere ("1 GB", "1.5 GB", "237 ms"); form labels, drop-downs, search boxes and segmented controls share one size and style; disk size in the new-VM wizard is a single control; page descriptions are rewritten to say what each page holds.

### Added

- **Hover a chart to read it.** Every metrics chart on the dashboard and the VM Metrics tab now shows the exact values and time under the pointer (tap on a touch screen). Charts over 7 and 30 days now label their axis with dates rather than times of day.

- **The dashboard says when its data stops.** If VirtPilot stops answering — during an upgrade restart, or a dropped connection — the dashboard shows "No data since 14:02:31 · retrying" and marks the host's status as unknown, instead of freezing the last numbers under a healthy verdict.

- **Each browser tab names its page and host**, e.g. "Virtual machines · db-host · VirtPilot", so several VirtPilot hosts open at once can be told apart.

- **Whole rows open what they show.** Click anywhere on a row in the VM list or Backups to open it. A VM's open tab is kept in the address (`?tab=snapshots`), so a reload or a shared link lands on the same tab, and the tabs can be moved between with the arrow keys.

### Fixed

- **On the 7-day and 30-day charts the time axis showed only hours and minutes**, so there was no way to tell which day a point was from.

- **The VM list's row actions overflowed their column** on running VMs and drew over the Memory column.

- **Several page titles sat 20 px to the left of their own content**, and jumped sideways between list pages and VM pages.

## [2.11.0] — 2026-10-08

### Changed

- **A new design, built from the logo rather than recoloured around it.** Every page keeps its layout — each section, table, tab and button is where it was — but the interface around it is new. The sidebar now follows your theme (light in light mode, with the full-colour logo), and each page sits on its own sheet, inset from the window. Boxes are instruments with a title bar and a hairline frame; rows of figures are one ruled strip instead of a grid of identical cards with tinted icon tiles; primary buttons are ink (frost in dark mode), and the steel blue is kept for what your eye should follow — focus, selection, links and data.

- **The dashboard opens on an instrument cluster.** CPU, memory, disk and running VMs are drawn as gauges in the shape of the logo's own dial — a ring with a gap at 45° — beside a one-line verdict for the host and the installed VirtPilot version. Host details are a ruled plate, the VM list shows each machine's state as a mark and a word, the update card carries the logo, and the metric charts sit in titled panels with their live reading in the title bar.

- **Status reads by shape as well as colour.** A solid disc is running, an open ring is stopped, two bars are paused and a diamond has crashed; warnings that are not a VM state use a small triangle. It still reads in greyscale and for colour-blind eyes.

- **Headlines use Inter Display**, the logo's own face, through Inter's optical-size axis; body text stays Inter and identifiers stay JetBrains Mono. Both are still bundled with the app.

- **The sign-in screen follows your theme** and carries the logo and its line, "KVM, steered from the browser".

- **Native controls follow the theme.** Drop-down menus and other built-in browser controls render dark in dark mode, checkboxes and radio buttons take the brand steel instead of the browser's blue, and the browser's own toolbar colour (on phones and installed apps) matches the app.

### Added

- **What the running VMs have been given, against the host.** The dashboard's VM panel ends with two meters — vCPUs and memory allocated to running guests against the host's cores and RAM — and turns amber when the host is over-committed.

- **A Backups filter on the Logs page**, next to VMs, Networks and System.

### Fixed

- **Three "back" links went to the wrong page.** The *Virtual machines* breadcrumb on a VM's page, the *Back to list* button on a VM that no longer exists, and the back link on *Create virtual machine* all led to the Dashboard instead of the VM list. *Back to list* was also a button nested inside a link, which is invalid markup.

- **A backup's next scheduled run always read "just now".** The per-VM page formatted a future time with the "time ago" helper, so the difference came out negative. It now says "in 3h", "in 2d" or "Soon".

- **Backup row actions spilled over their neighbours.** On the Backups list the three row buttons needed about 290 px in a 186 px column and drew over the Schedule column, and the per-VM history table did the same to Trigger. The columns are sized for their contents, and on narrow windows the actions become icon buttons with tooltips instead of scrolling out of reach.

- **A paused backup schedule was listed as "None"** while its own button said *Schedule*. It now reads *Paused*.

- **The VM page counted an empty CD-ROM drive as a disk** — *Disks: 2* on the Overview while the Disks tab listed one — and a VM whose only drives were the cloud-init seed and an empty CD-ROM showed a bare table header instead of *No disks attached*. Both now use the same filter.

- **A running VM was told to "Start VM to resolve" its IP address.** It now says *Not resolved yet* until the address appears; a stopped VM keeps the original hint.

- **Idle charts repeated their axis labels** ("1 B/s, 1 B/s, 1 B/s, 0 B/s") because an all-zero series was scaled to a 0–1 axis. Byte-rate charts on the dashboard and the VM Metrics tab now keep a 1 KB/s floor, and their labels no longer wrap onto two lines.

- **The new-VM wizard** labelled every disk "(blank)" on the Review step, including template-based VMs whose disk is the cloud image; showed its ISO-install notes in a light amber that was close to invisible on white; and showed neither an IP picker nor the "assigned by DHCP" note for an existing OS bridge on DHCP.

- **The same SSH key could be saved twice.** The server accepted an identical public key under any name, so a VM provisioned with both entries got the key twice in `authorized_keys`. A duplicate is now refused with a message naming the entry that already holds it, and the form shows the server's reason (a malformed key, or a duplicate) instead of "Failed to add SSH key".

- **About twenty kinds of log entry showed their internal key.** Backups, restores, verification and pruning, clones, renames, disk resize/move/download, device attach/detach, NIC rate limits, autostart, resource changes, hard resets and VirtPilot's own upgrades appeared as `backup.create`, `vm.clone` and so on. Every action the server records now has a name.

- **The VM list showed a generic server icon** for VMs whose operating system the dashboard already showed, and the dashboard ignored a logo picked by hand for a VM. Both now use the chosen logo first and the one implied by the VM's template otherwise.

- **Lines that should have divided the terminal windows were drawn in the light theme's border colour** across the dark apt-upgrade and self-upgrade windows, and the console header's separators never appeared: both used a colour class (`white/8`) that does not exist. The upgrade windows are now proper dialogs, and a finished job's window closes with Escape.

- **Tooltips never appeared on disabled buttons** — exactly when they explain why the button is disabled, such as the incremental-backup hint — and a long hint ran off the screen on one line. Disabled buttons now show their tooltip, and long ones wrap.

- **Controls a screen reader could not name or reach.** About thirty icon-only buttons (VM power actions, disk, snapshot, NIC, port-forward, firewall and boot-order actions, row actions on Storage, Templates, ISOs and Networks, several close buttons) were announced as just "button"; the wizard's switches had no names; several form labels were not tied to their fields; and saved SSH keys in the wizard could only be added with a mouse. A button inside a tooltip is now named by it, the rest are labelled, and the key list works from the keyboard.

- **Dates were written four different ways**, and snapshot and template dates followed the browser's locale (`10/8/2026, 4:33:17 PM` in an American-English browser). Every date now reads `8 Oct 2026`, with `16:33` where the time matters.

- **Smaller things:** the backups banner said "1 backup problem need attention"; an empty backup history told you to click a "Back Up Now" button that does not exist; and the VM list and VM page said "Active" and "Off" where every other page says Running and Stopped.

## [2.10.0] — 2026-10-08

### Changed

- **A new look, built around a refreshed logo.** The rocket-and-planet raster mark is replaced by *Heading* — an instrument ring with one heading needle — drawn as clean vector artwork in two quiet tones, slate and steel blue. The whole dashboard was restyled to match: the sidebar is the logo's ink tile, cards sit on hairlines instead of tinted gradient washes, blurred colour orbs and glowing stripes are gone, labels are sentence case rather than tiny spaced-out capitals, and status reads as a coloured mark and a word instead of a pulsing pill. The layout is unchanged — every page, tab and control is where it was.

- **Type is Inter, with JetBrains Mono for identifiers**, bundled with the app (see Fixed). Inter's tailed `l` and serifed `I` are switched on, so hostnames such as `vm-l1` and labels such as `I/O` cannot be misread. Headline figures use Inter's tabular numerals rather than bold monospace.

- **One colour vocabulary for every chart.** Single-series charts keep one hue per metric; paired series are always inbound (read, RX) in steel and outbound (write, TX) in dashed ochre, so a pair separates by colour *and* stroke and still reads in greyscale. Lines no longer glow.

- **Destructive buttons are ranked.** Solid red is now reserved for confirming a destructive act. In the VM header, Power Off — a graceful ACPI shutdown — is an ordinary button, and Force Off is outlined in red rather than filled.

- **Text you could barely read is now readable.** Several labels, step names and placeholders were set at 25–40 % opacity, and light-theme status text used shades as low as 2:1 against white. The palette's text shades now clear 4.5:1 on both the page and cards, and faded secondary text was raised to a legible level throughout.

- **A new house terminal theme, VirtPilot Slate**, is the console's default. A theme you had already picked is kept.

- **New favicon and app icons.** The browser-tab icon follows the browser's light or dark setting, and the dashboard now ships a web manifest with home-screen and maskable icons.

### Fixed

- **The dashboard loaded its fonts from Google on every page load.** Air-gapped and firewalled hosts fell back to system fonts, and every visit to a self-hosted dashboard was announced to a third party. Fonts are now bundled with the app, and the Content-Security-Policy no longer allows `fonts.googleapis.com` or `fonts.gstatic.com`.

- **The sign-in screen always said v1.7.0**, whatever was installed — it had its own copy of the version string that nothing updated. It now reads the same constant as the sidebar.

- **The sign-in screen's "System online" light was decoration.** It was always shown and never checked anything. It has been removed.

- **The VM header said "KVM" on hosts without `/dev/kvm`**, where guests actually run under TCG software emulation. It now reports what the host provides.

- **The VM header pushed the page sideways at narrower widths** (around 1024 px with the sidebar open): its six action buttons could not wrap. They now drop below the VM name when space runs out.

- **Stacked dialogs announced the wrong title to screen readers.** Every dialog labelled itself with the same fixed element id; each now has its own.

- **Development only:** the Vite dev server rejected every write with "Origin not allowed" when opened at `http://127.0.0.1:5174`, because its proxy rewrote the Host header to `localhost`. Reads still worked, so saves just looked flaky. The proxy now passes the browser's Host through.

## [2.9.1] — 2026-08-05

### Fixed

- **Every incremental-mode backup in 2.9.0 destroyed the checkpoint it had just created, so no chain could form.** 2.9.0 stopped counting the backup currently being written as leftover data — correct in itself, but it did so by hiding that directory from *every* scan. Checkpoint reconciliation runs at the end of a backup, while the backup is still registered as in progress, so it could no longer see the manifest written moments earlier and deleted the brand-new checkpoint as unreferenced. The backup then recorded a manifest naming a checkpoint that no longer existed: the history showed it as "Chainable", the degraded-runs alert was blinded because it trusts that same field, and the next run found the checkpoint missing and took another full backup. Only the display suppression is applied now, and never to a directory that holds a readable manifest.

- **A backup now confirms its checkpoint exists rather than assuming it.** The copy reported a checkpoint as created whenever one had been *asked* for, so anything that removed it afterwards went unnoticed and the manifest advertised a backup nothing could chain onto. libvirt is asked directly, and a missing checkpoint is recorded as a note on the backup.

  If you ran 2.9.0, any backup it took in incremental mode carries a checkpoint name that is not in libvirt. Nothing is lost — those backups restore normally — but the next run will take a full backup and lay down a working checkpoint.

## [2.9.0] — 2026-08-05

### Changed

- **"Incremental not possible — the previous backup did not record a checkpoint" now explains itself.** Switching a schedule to incremental made the very next run report that, which read as a fault in a full backup that was perfectly good. The message named a symptom and stopped: it never said that only a backup taken with incremental backups switched on records a checkpoint, and never said that the run writing the message had *just laid one down*, so the next run would be a true incremental. The wording now says both — and when a checkpoint genuinely could not be created, it says that instead, along with which copy method it fell back to.

- **The Incremental button used to give advice that could not work.** It was disabled whenever no checkpoint existed, with a tooltip saying "take a full backup first" — but a full backup taken from the button beside it records no checkpoint either, so following the instruction literally could never enable it. The only way out was a scheduled run. The button is now enabled whenever the host supports incrementals: with no checkpoint to chain onto, it takes a full backup *and* records one, which is what the engine was always designed to do.

- **The schedule dialog now warns before the fact.** Switching backup type to incremental says that the first run will still be a full backup and why. The list of reasons a run can fall back to a full also gained the missing checkpoint — the one cause that is near-certain the moment the setting is saved, and the only one it did not mention.

- **Storage Used counts backup directories that nothing can restore from.** They were filtered out of every listing, so a volume holding 95 GB could report 40 GB with nothing in the product to explain the difference.

### Added

- **An alert when a schedule set to incremental keeps producing full backups.** If the libvirt push-mode tier fails every night — an AppArmor denial, a stale job, a permissions problem — every run still succeeds as a full backup, so the schedule reported success, the banner still said "Incremental", and the only trace was a note buried in one row. Two consecutive non-chaining runs now raise a warning that quotes the underlying cause.

- **An alert for backup directories holding data nothing can use**, and an automatic sweep of the ones left behind by an interrupted run once they are a day old. A backend killed mid-copy never reached its own cleanup, so a part-written multi-GB image stayed on the volume forever, invisible to every total the product showed. Retention and the sweep now also run every twelve hours rather than only at startup — a host that simply stays up never reclaimed anything a per-VM pass did not cover.

- **Backups that carry a checkpoint are marked "Chainable"** in the history list, so it is visible which backup the next incremental will build on.

### Fixed

- **Opening the schedule dialog too quickly could silently downgrade an incremental schedule to "always full".** The dialog reads its initial values once, when it opens, and the button that opens it was clickable before the schedule had loaded. Clicking in that window built the form from blank defaults and then saved them explicitly — overwriting the VM's backup type, frequency, time and retention, with a "Schedule saved" toast and nothing to suggest anything had been lost. The button now waits for the data, and the dialog re-reads it if it arrives late.

- **An unreadable `backup-schedules.json` deleted every schedule on the host.** Any read failure — a truncated file, a syntax error, a permissions problem — was treated as "no schedules configured". Every automatic backup then stopped without raising anything (the overdue alert reads the same empty map), and the next schedule saved through the UI persisted that emptiness over the top. Reads now distinguish a genuinely absent file from a broken one, and writes go through a temporary file and a rename so a crash mid-write cannot truncate the store in the first place.

- **Two VMs due at the same minute could lose each other's schedule updates.** Saving a schedule is a read-modify-write of one shared file and the scheduler fires every due VM at once — and the dialog pre-fills 02:00, so several schedules really do come due in the same tick. Writes are now serialised. This also closes the window where an operator's change, saved while a scheduled run was recording its outcome, was silently reverted with a 200 OK.

- **Opening a failed schedule and pressing Save cleared the "last scheduled backup failed" alert.** The record of how the last run ended was rebuilt from the request body, which does not carry it — so investigating a failure was enough to hide it until the next run failed, up to a month later on a monthly schedule.

- **A backup that had already succeeded could be deleted by the housekeeping that runs after it.** The retention pass sat inside the same error handler that cleans up a *failed* copy, whose first act is to remove the backup directory. An unreadable settings file or a busy directory during that pass therefore destroyed a complete, restorable backup — and swept its checkpoint on the way out, so the next run degraded to a full as well.

- **One unreadable manifest could delete an entire backup chain.** A manifest that failed to read was indistinguishable from a backup that did not exist, which made an incremental's parent look like a childless leaf; retention removed it, and the peel loop cascaded down the chain, leaving every backup above it permanently unrestorable once the read recovered. Retention and checkpoint reconciliation now refuse to prune anything at all while any manifest is unreadable, and say which one.

- **A single unlucky capability probe disabled incremental backups until the service was restarted.** `virsh domcapabilities` reporting no backup support was cached for the process lifetime on the grounds that it could not change — but upgrading qemu and restarting libvirtd changes it. A negative answer is now re-probed; a positive one is still cached permanently.

- **Taking a full backup by hand on an incremental-mode VM now asks first.** It records no checkpoint, so the next scheduled run had nothing to chain onto and took a full backup as well — with no warning, and different behaviour depending on which screen the button was pressed from.

### Upgrade notes

- The v2.7.0 upgrade note claiming that "the first backup taken after upgrading also records a checkpoint" was wrong, and has been wrong since that release shipped. A checkpoint is only ever recorded for a VM whose backups are set to incremental. The note has been corrected in place.

## [2.8.2] — 2026-08-04

### Fixed

- **The in-dashboard upgrade cut its own output off after a few seconds and then looked like it had hung.** The endpoint watched the upgrade's systemd unit with `systemctl is-active`, which exits non-zero for *any* state other than exactly `active` — and the upgrade runs as a `oneshot` unit, which is `activating` for its entire life. The very first poll therefore read "not running", declared the upgrade finished about two seconds in, killed the live log part-way through `npm ci`, and reported the exit status of a process that hadn't exited (0).

  The dashboard then moved straight to "Backend restarted. Waiting for new version…" while the build had not yet started, and gave up 90 seconds later — often before the upgrade it was waiting for had actually finished. Both symptoms were the same bug: the upgrade itself was running normally the whole time.

  The unit's state is now read with `systemctl show -p ActiveState`, which reports the state instead of encoding it in an exit code, and the dashboard waits longer now that it starts waiting at the right moment.

## [2.8.1] — 2026-08-04

### Fixed

- **The in-dashboard update could stop dead after "Pulling latest changes…" with nothing to show for it.** Before resetting the working tree, `update.sh` switched it onto `origin/main` — and that switch refuses whenever a tracked file has been modified locally, which is exactly the drift the reset immediately afterwards exists to clear. `npm install` rewriting `package-lock.json` is enough to cause it. The switch is now forced, matching what the surrounding code already intended.

  The failure was also invisible: the command's output was discarded and the script exited on it without a word, so the update simply stopped mid-stream. It now reports what went wrong and where to look.

## [2.8.0] — 2026-08-03

### Added

- **Backups can now be verified, not just taken.** A backup was previously only ever read on the day you needed it — and an incremental is only as good as every backup beneath it. **Verify** walks the whole chain, confirms each image is present, and runs `qemu-img check` over every one of them. The result is kept with the backup, so the list shows what was last proved good and when.

- **Backups that stop working now say so.** A failed scheduled run used to leave nothing but a line in `journalctl`. The outcome is recorded on the schedule itself, and the Backups page carries a banner for anything that needs attention: a scheduled run that failed, one that is overdue and hasn't fired, a chain with a missing link, and a backup whose last verification failed.

- **Metrics go back further than a day.** Completed hours are folded into an hourly rollup and kept for 90 days, so **7d** and **30d** ranges join Live/1h/24h on both the dashboard and each VM's Metrics tab. Raw 30-second samples are still what the short ranges read; they are simply no longer the only thing stored, which is what capped history at 24 hours.

- **A test suite and CI.** 157 unit tests over the logic that has actually broken before — input validation, the SSRF guard, domain-XML generation and escaping, firewall rule validation, backup scheduling, backup-chain resolution and the clone/restore XML rewriting. CI additionally runs `shellcheck` over the installer scripts at *default* severity (the bug that had `install.sh` executing fragments of its own comments as root is only reported at "style", so a warning-level gate would have missed it), and checks that the four places a version has to be bumped actually agree.

### Fixed

- **The self-upgrade can finally carry its own migrations.** `update.sh` runs from the copy already on disk — the *previous* release's — so a release could never ship a fix that needed to run during its own upgrade. That is what made 2.6.0 able to lock operators out of their own dashboards. Once the working tree has moved, the update now hands off to the `update.sh` it just pulled and lets that finish the job.

  This release is still upgraded by the old script, since that is the one on disk; from the next release onward a fix can travel with the upgrade that needs it.

- **Cloning or restoring into a new VM carried over the source's cached backing-file chain.** libvirt records that chain in the VM definition, and the copy's disks are standalone — so the new VM described a chain its files did not have. The same stale-cache condition makes qemu refuse to open a disk outright. Found by the new tests.

- Invalid firewall rules now name which rule is at fault, rather than reporting the bad value with no indication of where it came from.

## [2.7.1] — 2026-08-03

### Fixed

- **`git clean` inside the install directory could permanently break the SSH tab for every existing VM.** The service account's home is the install directory itself, so the SSH keypair VirtPilot injects into every VM it builds lives at `/usr/local/virtpilot/.ssh/`. That path was untracked but not ignored, so a plain `git clean -fd` — the obvious thing to reach for when a clone gets wedged — deleted it. The backend then quietly generates a fresh keypair, so newly created VMs keep working while every VM created before that moment still has the old key in its `authorized_keys` and can never be reached from the SSH tab again. The serial console is the only way back in.

  Nothing VirtPilot ships has ever run `git clean` — `update.sh` uses `git reset --hard`, which leaves the directory alone — so no install can have hit this on its own. The keypair is now git-ignored, which is enough for `git clean -fd` to spare it.

## [2.7.0] — 2026-08-03

Backups become incremental, restores become whole-machine, and VMs can be cloned.

### Added

- **Incremental backups.** A backup can now copy only the blocks that changed since the previous one, using libvirt checkpoints and qemu's persistent dirty bitmaps. Each incremental is a qcow2 whose backing file points at its parent, so a chain reads as one complete image — restoring any link rebuilds the whole thing automatically, and the Backups page shows both the link's own size and what the full chain costs.

  Schedules gain a **backup type**: *always full*, or *incremental with a fresh full every N backups*. Capping the chain is deliberate — a long chain is slow to restore and puts every backup after a damaged link at risk. A scheduled run that cannot produce an incremental (the VM was off, the previous checkpoint is gone, the host does not support it) takes a full backup instead of being skipped, and records why on the backup.

  Deleting a backup that later incrementals are built on is refused rather than silently orphaning them; the dialog offers to remove the whole subtree instead. Retention follows the same rule — an expired full backup with a live incremental on top of it survives until that incremental expires too.

- **Restore into a new VM.** Restoring no longer only means overwriting the VM the backup came from. The backup already stored the domain definition, NICs and cloud-init metadata, so it can now rebuild the entire machine: new UUID, new MAC addresses, a fresh IP where the original had a static one, its own NVRAM, and a regenerated cloud-init seed so the guest boots with the new name as its hostname. This works even when the original VM has been deleted.

- **Clone a VM.** One action produces a complete, independent copy — new identity throughout, disks copied in full rather than layered on the original. A running VM does not have to be shut down first: the copy is taken through the same point-in-time machinery as a backup.

### Changed

- **Backing up a running VM no longer freezes its filesystems for the length of the copy.** The guest agent was asked to freeze before the copy started and thaw only once every disk had finished — up to an hour of stalled I/O on a large disk, long enough to trip guest watchdogs and hang every application on the machine.

  Where the host supports it, backups now use libvirt's push-mode backup API: qemu takes the point-in-time internally and copies in the background, so the freeze lasts only as long as it takes the job to start. Where it doesn't, the VM is pivoted onto a throwaway overlay for the duration of the copy and committed back afterwards. Both are measured in milliseconds of guest impact rather than minutes, and both are recorded on the backup so you can see which ran.

  The old behaviour is still available as a last resort if neither mechanism works, but it now copies the live disk *without* a long freeze and marks the result crash-consistent, rather than stalling the guest to reach the same outcome.

- **The backup manifest no longer stores the guest password in plain text.** It is encrypted with the same key as `vm-metadata.json`. Manifests written by earlier versions are read as before.

- README no longer claims incremental backups it did not have. It does now.

### Fixed

- **A port forward could silently punch a hole through a deny-all firewall.** The per-VM firewall and port forwarding both wrote to the same iptables chain, and whichever was configured last ended up on top — so setting the firewall first and adding a forward afterwards left the forward bypassing the policy entirely, while the opposite order blocked it. Identical settings, opposite security outcomes. The firewall is now always evaluated first: a forwarded port on a VM with a deny-all inbound policy needs an explicit allow rule, which is visible and fixable.

- **Port forwarding never actually worked on a managed NAT network.** The DNAT rule was right, but the `FORWARD ... ACCEPT` that lets the translated packet through was appended below libvirt's own rules — and libvirt's chain ends by rejecting forwarded traffic to the guest bridge. Connections were refused before VirtPilot's rule was ever consulted, while the DNAT counter ticked up as if all was well. The rule is now inserted ahead of libvirt's.

- **A snapshot taken while the VM was shut down could never be deleted.** libvirt only hands an overlay to the qemu user when there is a running qemu to hand it to, so a snapshot of a stopped VM left a file the service account could neither read nor change permissions on. Deleting it failed with "Permission denied", and the VM was left running off an overlay it could not get rid of. Overlays are now created by VirtPilot itself with the right ownership.

- **Applying a deny-all firewall could lock you out of your own firewall.** Rules are applied against the VM's IP address, which was resolved from the host's ARP cache — and a deny-all inbound policy is precisely what stops that resolving. The next apply, including the one undoing the policy, failed with "Could not resolve VM IP". DHCP leases are now consulted too, which the guest's reachability cannot affect.

- **Restoring a backup could leave the VM unable to start.** libvirt caches each disk's backing-file chain in the VM's definition; replacing the image out-of-band left that cache describing a chain the file no longer had, and qemu then refused to open the disk at all. Restore now clears the cache so libvirt re-reads it from the images.

- **Invalid firewall rules were accepted and only failed later.** A rule with an out-of-range port saved successfully and blew up at apply time, after you had left the page. Rule sets are validated when saved, and rejected with a message naming the rule at fault.

- **`install.sh` ran fragments of its own comments as root.** Two comment lines inside the systemd-unit template contained backticks, which the shell executed while writing the file — printing three confusing errors on every install and blanking those comments out of the installed unit.

- **Deleting a VM without deleting its storage could be refused once it had been backed up.** libvirt will not undefine a domain that still carries checkpoint metadata unless told to drop it, and nothing else clears it when the disks are being kept. `virsh undefine` is now asked to remove it, with a fallback for libvirt older than 5.6.

- Un-ticking a storage directory's "use as default" checkbox appeared to work but never could — every purpose must always have exactly one default. The checkbox is now disabled once the directory holds the flag, with an explanation.

- Malformed request bodies returned "Internal server error" instead of a 400, and filled the log with stack traces. Several operations that were refused for legible reasons — restoring onto a running VM, snapshotting a VM with backup checkpoints, deleting a template that does not exist — reported themselves as server faults rather than 4xx.

- A restore refused for a reason the operator can act on — the VM is still running, the name is taken, the backup's chain is incomplete — now returns the matching 4xx status instead of reporting a server error.

### Upgrade notes

- Existing backups keep working untouched and are treated as full backups. A backup records a checkpoint only when incremental backups are switched on for that VM — a checkpoint pins a dirty bitmap inside the qcow2 and blocks every snapshot operation on the disk, so it is never created for a VM that has not asked for one. Switching a schedule to incremental therefore still takes a full backup on its first run; that run lays down the checkpoint, and the run after it is a true incremental. *(Corrected in 2.9.0 — this note previously claimed any post-upgrade backup recorded a checkpoint.)*
- Incremental backups require a running VM and a host whose `virsh domcapabilities` reports `<backup supported='yes'/>` (libvirt 6.0+ with a qemu that has `blockdev-backup` — anything on Ubuntu 22.04 or newer). The Backups page says which of these is missing when the Incremental button is unavailable.
- Cloning and restore-into-a-new-VM carry over attached ISOs but not the source's cloud-init seed, and turning off "give the clone its own identity" will duplicate a static IP — the dialog says so.

## [2.6.1] — 2026-07-27

### Fixed

- **Upgrading to 2.6.0 locked operators out of nginx-fronted installs that had an IP allowlist configured.** 2.6.0 stopped trusting `X-Forwarded-For` unless `TRUST_PROXY` was set, which was the right call for a directly-exposed backend but wrong for the standard install: every request then resolved to `127.0.0.1`, matched no allowlist entry, and login returned `403 IP not allowed` while the service itself reported healthy.

  The `TRUST_PROXY` migration shipped in 2.6.0's `update.sh` could never have prevented this. The in-dashboard self-upgrade executes the `update.sh` already on disk — the *previous* version's — so a migration only takes effect from the release *after* the one that needs it.

  The bind address now settles it without an env var. A backend bound to loopback is unreachable from the network, so the only thing that can set `X-Forwarded-For` is a proxy on the same host, and one hop is trusted. A backend bound to a routable address may be directly exposed, so it keeps ignoring the header until `TRUST_PROXY` says otherwise. An explicit `TRUST_PROXY` still wins in both cases, so existing configurations are unaffected.

  If you were locked out by 2.6.0, this release restores access on its own — no `.env` edit needed. Adding `TRUST_PROXY=1` by hand remains a valid fix and is left alone if present.

## [2.6.0] — 2026-07-27

Security and robustness release from a full audit of the codebase. Two changes need operator attention — see **Upgrade notes** at the end.

### Security

- **Proxy headers are no longer trusted by default.** The backend trusted one proxy hop unconditionally, so any install reachable directly (`BIND_ADDRESS=0.0.0.0` without a reverse proxy) let an unauthenticated client spoof `X-Forwarded-For` and walk straight past login rate limiting, 2FA rate limiting and the IP allowlist. Client IPs now come off the socket unless `TRUST_PROXY` opts in; `update.sh` sets it automatically for nginx-fronted installs.
- **A failed secret decryption no longer silently disables 2FA and the IP allowlist.** `getUserSettings()` caught every error and returned defaults, so a rotated or mismatched `ENCRYPTION_KEY` turned two-factor auth off and emptied the allowlist without a word — and the next settings save made it permanent by overwriting the TOTP secret. Only a genuinely absent settings file now yields defaults.
- **Disk-download tickets are no longer accepted as full session tokens.** The short-lived ticket that authorises a single disk download travels in a URL query string (so it lands in proxy logs and browser history) but satisfied every authenticated endpoint and WebSocket. Session tokens now carry a `typ` claim that tickets deliberately lack.
- **VM creation can no longer inject arbitrary libvirt device XML.** `nicModel` from the create request reached the generated domain XML unvalidated and unescaped, so a crafted value could close the attribute and append devices — an extra `<disk>` pointing at a host block device, a `<serial>` writing to an arbitrary path — into a domain that is then persisted by `virsh define`. All interpolated values are now escaped at the builder, and the route validates before anything touches disk.
- **The service account can no longer rewrite the script that runs as root.** `update.sh` was owned by the unprivileged service user while sudoers granted it `NOPASSWD` root execution. It is now root-owned, and the (unused) grant is gone. The `systemctl` and `apt-get` grants have been narrowed to the exact commands the dashboard issues — the previous bare `apt-get` grant was a root shell in disguise.
- **Logging out now survives a restart.** Revoked tokens were held in memory only, so a service restart — which every self-upgrade performs — brought them back to life. Revocations are now persisted (hashed) in the existing database.
- **The download SSRF guard actually resolves hostnames now.** It classified only literal addresses, so a hostname pointing at a private or link-local address passed, and IPv4-mapped IPv6 literals (`[::ffff:169.254.169.254]`) matched none of its patterns. It now resolves the host, rejects any private answer, and pins the connection to the address it validated.
- Snapshot descriptions are passed as a named option instead of a bare argument, so a description starting with `--` can no longer be parsed by `virsh` as a flag (`--print-xml` made the API report success while creating nothing).
- Uploaded archives are now capped on decompressed size, and the SSH WebSocket's pre-connection input buffer is bounded.

### Fixed

- **Three ways to kill the backend, one of them unauthenticated.** A login attempt with a non-ASCII password crashed the process outright — the length check counted UTF-16 units while the comparison used UTF-8 bytes, and the mismatch threw inside an async handler. An ISO download filename containing a space threw outside its error handler. WebSocket handlers registered their `error` listener only after several awaits, so a malformed frame arriving in that window took the whole daemon down — along with every live console, SSH and VNC session. All three are fixed, and process-level guards now keep the service up rather than letting one bad request end it.
- **Console, SSH and VNC sessions no longer leak.** A client that vanished without closing cleanly (laptop lid, dropped Wi-Fi) left a `virsh console` pty, an SSH channel into the guest, or a VNC socket to QEMU held open forever — and the VNC leak blocked all future VNC sessions for that VM. All three now use a heartbeat, and a client that disconnects mid-connect no longer leaves a guest shell behind.
- **Deleting an "orphaned" disk during a libvirt outage no longer deletes live VM disks.** When libvirt was unreachable the check for "is this VM still defined?" failed open, the Storage page marked every disk orphaned, and the delete button removed real data. The check now fails closed and returns an error.
- **Uploads and snapshot exports no longer overwrite live disk images.** Templates are backing files for every VM created from them; writing over one corrupted running guests. Colliding writes now return a conflict, and the cross-filesystem move path writes to a temporary file and renames rather than rewriting an inode QEMU has open.
- **Firewall rules are no longer torn down before they are validated.** The existing chains were flushed first, so a rule set that failed to apply left the VM with no filtering at all while the API reported success. Rules are now built and validated up front, applied strictly, and rolled back on failure. Stale rules from a previous VM IP are swept properly.
- **Port forwarding no longer hijacks other guests' traffic.** The NAT rule matched on destination port alone, so forwarding a host port to one VM silently redirected every other guest's outbound traffic on that port. Rules now match on the inbound interface; existing rules are reconciled automatically at startup.
- **A backup schedule with an unrecognised frequency no longer loops every minute** until the disk fills.
- **VM names accepted at creation now match what the rest of the app accepts.** The create form was more permissive than the validator, so a name like `_build01` created a VM that could not then be opened, started or deleted from the dashboard.
- **Cloud-init passwords containing `:` or `\` now work.** They were escaped for a format that treats neither character specially, so the backslashes became part of the guest password while the dashboard displayed the original.
- **VM metadata writes no longer race.** Concurrent updates could interleave and a torn file was read as "no metadata for any VM", which the next save then made permanent. Writes are serialised and atomic.
- A failed bridge-network creation no longer leaks the bridge and wedges the name counter; a failed port-forward no longer leaves an unremovable rule behind.
- `uninstall.sh` no longer deletes VM disks it did not create — it selected any domain whose XML merely mentioned the storage path, which matched every VM and some hand-made ones.
- `install.sh` no longer disables nginx's default site, and `bootstrap.sh` no longer redeploys a stale commit while reporting success.
- Frontend: the starter-template downloader could run twice across tabs and corrupt the download; the Backups page hid backups belonging to deleted VMs (and excluded them from the storage total); the network step of the VM wizard let you continue without a required static IP; snapshot-to-template timed out in the UI while succeeding on the server; a cleared disk-size field silently provisioned 20 GB.

### Changed

- **Re-running `install.sh` no longer destroys an existing install.** It regenerated `JWT_SECRET` and `ENCRYPTION_KEY` and rewrote `.env` wholesale — orphaning every encrypted value on disk and discarding operator edits. It now reuses existing secrets, keeps the current password unless `VP_RESET_PASSWORD=1`, and preserves unrelated settings.
- Dependencies updated for published advisories, including `tar` (critical — used by backup and restore) and `ws` (high — every console session).

### Upgrade notes

- **Behind a reverse proxy:** `update.sh` adds `TRUST_PROXY=1` automatically when it detects the nginx site. If you front VirtPilot with something else, add `TRUST_PROXY=1` to `packages/backend/.env` yourself, or client IPs will all appear as the proxy's address and an IP allowlist will lock you out.
- **Replacing a template or ISO** by uploading over an existing one now returns a conflict instead of silently overwriting. The dashboard does not yet offer a "replace" toggle — delete the old file first.
- **VMs created with a name the validator rejects** (a leading underscore, or longer than 63 characters) remain unusable from the dashboard; rename them with `virsh domrename`.
- **Existing sudoers rules are not rewritten by `update.sh`** — re-run `install.sh` to pick up the narrowed grants.

## [2.5.4] — 2026-06-03

### Changed

- **Dashboard health band no longer truncates long hostnames.** The host status line previously crammed the hostname and VM count onto one line (`slc-gateway.hostedai.dev · 1/1 VMs running`), so longer hostnames were cut off. The hostname now sits on its own line with the VM count beneath it; the full name is available on hover. The status block stays vertically centred against the vitals and version chip, so card alignment is unchanged.

## [2.5.3] — 2026-06-02

### Fixed

- **Action tooltips now appear on every VM action.** `Tooltip` injected its hover handlers into the wrapped child element, so it only worked when that child was a raw DOM element. The console action is a plain `<a>` and worked, but the power on / reboot / hard reset / shutdown / force off / delete actions use a button component that didn't forward the handlers, so their tooltips never fired. The hover (and now keyboard-focus) listeners sit on the tooltip's own wrapper instead, so tooltips work regardless of child type — fixing the same latent gap across the Templates, ISOs, Storage and VM detail pages too.

## [2.5.2] — 2026-06-02

### Fixed

- **Backups page styling now matches the rest of the app.** In the VM list, the machine name rendered in a lighter sans-serif at the wrong size and sat top-aligned against its icon. It now uses the same `font-mono` semibold treatment as the VMs list and is vertically centred. Numeric columns (backup count, disk count) were a mix of mono and sans within the same tables — they are now consistently mono, matching the Size column and the VMs table.

## [2.5.1] — 2026-06-02

### Fixed

- **Dashboard Memory readout no longer flashes long decimals on refresh.** The animated count-up feeds floating-point intermediate values to the formatter; the sub-GB branch printed them raw (e.g. `412.38109283 MB`) until the value crossed into the GB range. It now rounds to whole MB, matching the CPU/Disk/Network readouts.
- **Starter template set: refreshed dead image URL.** The Fedora 41 Cloud image was returning HTTP 404 — its mirror had pruned the release — so the starter set now ships **Fedora 44 Cloud** (the current stable Generic Cloud image).

### Added

- **Ubuntu 26.04 LTS Resolute** added to the starter template set.

## [2.5.0] — 2026-06-02

### Added

- **Dashboard health summary band.** A full-width strip pinned to the top of the dashboard gives an at-a-glance verdict — *All systems healthy* or *N warnings*, derived from KVM availability plus CPU/memory/disk thresholds — alongside CPU, memory and disk vitals (with micro-bars), the running/total VM count, and a VirtPilot version chip. The verdict icon carries a slow pulse and the version chip jumps to the update card.
- **VM roster on the Overview row.** The old 2×2 stat tiles are replaced with the actual machines, grouped by status (running first). Each row shows a per-OS logo derived from the VM's source image, a live status dot, autostart and guest-agent flags, a recent-CPU sparkline for running VMs, and the vCPU/RAM allocation — and links straight to the VM. The VM list response now carries the source image filename and recent CPU history, so this needs no extra per-VM requests.
- **Live, animated metrics.** Vital readouts and the metric-card values count up on load and glide between polls (honouring `prefers-reduced-motion`); every chart line carries a glowing "live" endpoint marker pinned to the latest sample; and the metrics range toggle shows a pulsing dot when *Live* is selected.

### Changed

- **Host Metrics are now a responsive 2×2 grid** (CPU / Memory / Disk / Network) instead of four full-width stacked charts — roughly a third less scrolling, falling back to a single column on narrow screens.
- **Host identity card reworked into one aligned spec sheet** — Hostname / CPU / QEMU / Kernel / Libvirt / Load / Network now share a single label→value rhythm with one consistent value style, replacing the previous mix of fonts and weights.
- **The Overview row stacks responsively** (below the `lg` breakpoint) so the host card no longer truncates on smaller screens.
- **The VM console route (and its noVNC dependency) is lazy-loaded**, trimming the main bundle so the dashboard's initial load is faster; noVNC is also excluded from dev pre-bundling to fix a dev-server startup error.

## [2.4.1] — 2026-05-13

### Changed

- **VM console popup window enlarged from 960×600 to 1200×760.** The header carries a lot now (tab switcher + connection state + VM action buttons + theme picker) and visibly crowded at 960. 1200 leaves the header airy and gives the terminal ~150 cols × 48 rows of usable area without losing the "popup, not a full browser window" feel.

## [2.4.0] — 2026-05-13

### Added

- **Terminal theme picker.** A palette button in the VM Console header switches the xterm colour scheme between Tokyo Night (default), Dracula, Catppuccin Mocha, Gruvbox Dark, Nord, One Dark, and Solarized Dark. Themes apply to both the Console and SSH tabs and to the page chrome background. The choice is per-device (localStorage key `virtpilotTerminalTheme`) and is applied live without tearing down the active session — switching mid-`htop` repaints in place.
- **VM consoles can open in a popup window.** A toggle on the VMs page (default ON) routes the Console buttons (VMs row + VM detail action bar) to a 960×600 borderless popup instead of in-tab navigation. A second click on the same VM's button focuses the existing popup rather than spawning duplicates. The popup detects `window.opener` and hides the back-to-VM link. If the browser blocks the popup we fall back to in-tab navigation and toast a hint. The preference persists per-device via localStorage (`virtpilotUserPrefs`).

### Changed

- **VM console + SSH terminal rendering and responsiveness overhaul.** The in-dashboard terminal (both Console and SSH tabs) now uses the Canvas renderer (~5–10× faster paint than the DOM default; ditched the WebGL option because its cached glyph atlas garbles output when a font is substituted mid-session). System monospace stack (Menlo / Consolas / DejaVu Sans Mono) replaces Geist Mono so unicode glyphs nano/vi paint in status bars don't trigger per-glyph font substitution at non-monospace widths. Cell-aligned width calculation (bypasses FitAddon's hard-coded scrollbar reservation) makes nano/vi/htop render edge-to-edge with no right-side gap and no clipped bottom row. ResizeObserver with rAF coalescing replaces window.resize so font loads, sidebar reflows, and drag-resizes all refit correctly without spamming the pty. Ctrl+Shift+F searches the scrollback; Ctrl+Shift+V/C handles clipboard paste/copy. Auto-reconnect with exponential backoff (250 → 500 → 1000 → 2000 → 5000 ms) keeps the session alive across network blips; 20 s keepalive ping prevents NAT timeouts; the existing scrollback survives reconnects. Thin indeterminate progress bar shows during (re)connect.

### Fixed

- **SSH terminal pty booted at placeholder 220×50 instead of the client's actual geometry.** The backend's WebSocket message handler was attached inside the `ssh.shell` callback, which fires only after the SSH handshake completes (50–300 ms). The client's first resize message (sent on WS open) lands at the backend before any listener exists, and Node's `ws` library silently drops it. The pty therefore booted at the placeholder 220×50 and nano/vi/htop painted their UI at that geometry — visible as a chunky right-side gap because the terminal is actually rendered at ~150 cols. The message handler now attaches at WS upgrade time and the pty is opened at the latest client-reported `cols`/`rows`; any keystrokes the user typed during the handshake are buffered and drained when the shell stream is ready.
- **Pty I/O is now binary on the wire.** Pty output goes out as binary WebSocket frames (no UTF-8 round-trip on either side) and keystrokes go in as binary, with text frames reserved for JSON control messages (`resize`, `ping`). This also closes a JSON-paste hijack — a pasted `{"type":"resize",…}` no longer accidentally resizes the pty.

## [2.3.5] — 2026-05-05

### Fixed

- **Dashboard self-upgrade timed out when source had been hand-rolled forward.** `update.sh`'s "already up to date" early-exit was gated only on `BEFORE == AFTER` (no new commits fetched). When a previous `git reset --hard` had advanced source past the running build — for instance because v2.3.4's update.sh was recovered onto disk manually before the in-dashboard update was retried — the script saw "no commits to pull" and skipped the rebuild + restart entirely, leaving the running service stuck on the old version. The dashboard's poll then waited 90s for the new version constant and timed out. The build step now writes a `dist/.version` sentinel from the source `package.json`, and the early-exit additionally requires the built version to match source. A mismatch logs `Source unchanged but built artefacts (X) lag source (Y) — rebuilding` and falls through to the normal build path.

## [2.3.4] — 2026-05-05

### Fixed

- **In-dashboard self-upgrade failed with "You are not currently on a branch."** `bootstrap.sh` pins fresh installs to the latest release tag (`git checkout v<release>`), which leaves HEAD detached. The previous `update.sh` then ran `git pull --ff-only`, which has no upstream to merge with on a detached HEAD and aborted the entire update. The pull step is now `git fetch --tags --prune origin` followed by `git checkout -B main origin/main` and `git reset --hard origin/main`, so the working tree is forced back onto `main` regardless of the prior state — detached HEAD, package-lock.json drift from a previous `npm install`, a stale local `main` that diverged from origin, anything. Operator state (STORAGE_ROOT, .env, the generated `.ssh/` host keypair, node_modules) lives outside git and is untouched. **One-time recovery on hosts already stuck in detached HEAD on v2.3.2:** run the three git commands from inside `/usr/local/virtpilot` to land on the new code, then re-trigger the update from the dashboard.

## [2.3.3] — 2026-05-05

### Fixed

- **Console / SSH / VNC tabs returned 403 once an IP whitelist was configured.** The Express HTTP API uses `req.ip` (which honours `app.set('trust proxy', 1)` and resolves to the real client from `X-Forwarded-For`), but the raw `server.on('upgrade')` handler was checking `req.socket.remoteAddress` directly — which behind nginx is always `127.0.0.1`. Any non-empty `ipWhitelist` therefore rejected every WebSocket upgrade with HTTP 403, breaking all three terminal tabs while leaving the rest of the dashboard fully functional. The upgrade handler now mirrors Express's `trust proxy` walk over `X-Forwarded-For` before applying the whitelist. Regression since v1.6.0; only manifested for installs that had ipWhitelist set.
- **Stale `virsh console` children outliving their WebSocket.** When a console tab disconnected, node-pty's default `kill()` sent SIGHUP — which `virsh console` ignores while blocked in a libvirt RPC, leaving an orphaned client attached to the VM's serial PTY across browser refreshes. Cleanup now sends SIGTERM and escalates to SIGKILL after a 1.5s grace period, so the next connection always starts from a clean slate.

## [2.3.2] — 2026-05-05

### Added

- **Storage-directory ownership advisory.** When you register a directory whose group is not `virtpilot`, the dashboard now surfaces a warning toast at register time and an amber "warning" chip on the directory's row in the Storage page. The chip's tooltip prints the exact `chgrp + chmod` command to fix it. libvirt-qemu (a member of the `virtpilot` group) needs to traverse the registered dir to read VM disks; without this advisory, an operator who mounted iSCSI/NFS without setting the right group would only discover the problem when a VM failed to start with a cryptic "Permission denied" error from libvirt. The check re-runs on every Storage-page refresh, so re-mounts that change ownership are picked up live without re-registering.
- **Explicit `chown` of created subdirs.** When creating `templates/` / `isos/` / `vms/` inside a registered storage dir, VirtPilot now `chown`s them to `virtpilot:virtpilot` after the `mkdir + chmod 0770`. No-op for fresh `mkdir` output (we're already the owner) but defends against parent dirs with the setgid bit set or unusual umasks that would otherwise force a different group on the new subdirs.

VirtPilot still does not auto-`chown` the operator-supplied parent dir — operators have legitimate reasons their mount is owned a particular way (shared with other services). The advisory tells you what to fix; the `chgrp` runs as root via `sudo` so it's the operator's call to make.

## [2.3.1] — 2026-05-05

### Fixed

- **Move button missing on the VmDetail Disks tab.** `getVmDisks` enriches each disk row with `storageDirId`/`storageDirName` so the UI knows where the file lives. The lookup ran `virsh domuuid <name>` to convert a libvirt name to UUID, but every public API path passes the UUID *directly* — and `virsh domuuid` errors out when fed a UUID. The catch swallowed the error, the disk-locations map ended up empty, and the Move button (gated on `d.storageDirId`) never appeared on the VM detail page. Detect a UUID-shaped input and skip the round-trip.
- **Move-to-wrong-purpose returned HTTP 500 instead of 4xx.** Templates `/move` and ISOs `/move` had a single 500 catch-all. `ValidationError` is now mapped to 400, and "not flagged for {purpose}" / "already exists in" errors map to 409 (the storage-dirs CRUD route already did this; templates/isos were inconsistent).
- **`/tmp` and `/var/tmp` were not in `assertPathSafe`'s forbidden list.** Operator could register them as storage dirs. `/tmp` is cleared on reboot, silently destroying VM disks on the next host boot — a sharp footgun. Added both to the forbidden list.
- **Relative-path registration error message was misleading.** A relative input like `templates` got rejected with "cannot be inside the VirtPilot install directory" because `path.resolve` ran the input through the install dir's `process.cwd()`. Reject relatives up-front with a clear "must be absolute" message.

These were all surfaced by the [QA.md](QA.md) full pass against a clean v2.3.0 install.

## [2.3.0] — 2026-05-05

### Added

- **Move templates, ISOs, and VM disks between storage directories.** Each row in the Templates list, ISOs list, and the Storage page's VM Disks table gets a "Move to another storage directory" button alongside Delete. The destination picker filters to directories flagged for that purpose. Moves are physical file moves on disk (cross-filesystem aware — falls back to copy + unlink when source and destination are on different mounts). VM disks additionally get their domain XML rewritten so libvirt knows the new path; the VM must be stopped before its disk can be moved (moving a live qcow2 underneath QEMU corrupts it). Templates with VMs created from them are blocked from moving — the qcow2 backing chain encodes the absolute template path at create time, so moving would silently break those VMs at next start; the operator gets a clear error listing the affected VMs. ISOs currently attached as a CDROM to any VM are blocked for the same reason: their domain XML has the absolute path baked in.

- **Missing-file detection for VM disks.** The VM detail page now surfaces an "missing" badge on any disk whose source path no longer exists on the host (mount disappeared, file deleted out from under VirtPilot, manual `mv` outside the dashboard). The source path text turns amber and a tooltip explains the VM will fail to start until the file is restored or the path corrected. Each disk row also shows which storage directory holds the file. Detection runs on every VM info refresh — no stale-cache surprises.

## [2.2.0] — 2026-05-05

### Added

- **Multiple storage directories.** Templates, ISOs, and VM disks no longer have to live under `/var/lib/virtpilot`. Mount any local disk, NFS share, or iSCSI volume to a folder, register it on the redesigned Storage page, and pick it when uploading a template, downloading an ISO, creating a VM, or adding an extra disk. Each registered directory is purpose-tagged (templates / ISOs / VM disks — any combination), shows free/used space with a health indicator, and one directory per purpose can be flagged as the default for new uploads. The original `/var/lib/virtpilot` layout is auto-seeded on first boot as the "Local" directory with all three purposes set as default, so existing flows keep working untouched. Per-VM control state (NVRAM, name.txt, cloud-init seed) stays on the system root so libvirt can still start a VM if a non-default mount drops; only the qcow2 disk files migrate to the chosen directory.

  Under the hood: new `storage_dirs` and `vm_disk_locations` SQLite tables (migration 3), `/api/storage/dirs` CRUD endpoints, `storageDirId` field threaded through every upload, download, and disk-create call, and a new `<StorageDirSelect>` picker reused across the Templates / ISOs / VM Create / Add Disk dialogs. Cross-filesystem uploads use a scratch dir under `STORAGE_ROOT/.uploads` and copy+unlink instead of rename when the destination is on a different mount.

## [2.1.0] — 2026-05-04

### Added

- **Download a VM's disk image.** New download buttons on the VM detail "Disks" tab and on the Storage page next to each qcow2 file. Clicking either streams the disk straight from the host to the browser — no temp file, no double disk usage — so disks of any size go through without buffering. The VM must be stopped (or undefined / orphaned) before its disk can be downloaded; otherwise the file is being mutated live and the download would be torn. The button is disabled with a tooltip when the VM is running. Auth uses a single-shot, 60-second signed ticket bound to that one filename rather than the regular Bearer token, so it can ride in the URL without exposing the long-lived session. Useful for moving VMs between VirtPilot installations: download the disk on the source host, upload it back as a template on the destination.

## [2.0.5] — 2026-05-04

### Fixed

- **Snapshot revert and snapshot-export-to-template still failed after v2.0.4**, this time on the *write* side. `qemu-img create -b sealed overlay` couldn't create the revert overlay inside `vms/<uuid>/` (the dir was 0755 owned virtpilot:virtpilot — group can read+traverse but not write), and `qemu-img convert ... templates/<dest>.qcow2` couldn't write into the templates dir for the same reason. v2.0.5 bumps the storage subdirs to mode 0770 in `ensureDirs()` (templates, isos, vms, cloud-init, backups) so libvirt-qemu — a member of the virtpilot group via v1.21.6's group plumbing — can write into them. Per-VM dirs are also chmodded to 0770 in `createVmDisk` / `createBlankPrimaryDisk` / `createBlankDisk`. The parent `/var/lib/virtpilot` stays at 0750 from install.sh — the group can still traverse to find subdirs but can't see siblings.

## [2.0.4] — 2026-05-04

### Fixed

- **Snapshot delete (stopped path) and disk resize on a post-snapshot active disk still failed after v2.0.3.** v2.0.3 routed VM-disk qemu-img calls via `sudo -u libvirt-qemu`, but external snapshot overlays emerge from `virsh snapshot-create-as` owned `virtpilot:virtpilot` mode 0600 — meaning libvirt-qemu (a member of the virtpilot group, but not the owner) could neither read nor write them. The qemu-img-as-libvirt-qemu invocations therefore EACCESed on the overlay even though the helper itself was correct. v2.0.4 adds a chmod 0660 in three places: (1) right after `virsh snapshot-create-as` succeeds, on every newly-created overlay path; (2) defensively at the start of each `deleteSnapshot` iteration in case libvirt has re-chowned in the interim; (3) in `resizeDisk` before invoking `qemu-img resize`, since the active disk may itself be a snapshot overlay. With the file mode at 0660 the virtpilot group (which includes libvirt-qemu per v1.21.6's group plumbing) gets read+write, and the qcow2-chain operations all succeed under either user.

## [2.0.3] — 2026-05-04

### Fixed

- **Snapshot delete (and other qcow2-touching operations on started VMs) failed with `qemu-img: Could not open …: Permission denied`.** Once a VM has run, libvirt's `dynamic_ownership=1` chowns the active qcow2 to `libvirt-qemu:kvm` mode 0644 and the snapshot overlay to mode 0600. The unprivileged backend user (`virtpilot`) can read mode-0644 group-readable files but cannot write them, and cannot read mode-0600 files at all — so any `qemu-img commit`, `qemu-img info` on the overlay, `qemu-img resize`, or `qemu-img convert` (snapshot-export-to-template) hit EACCES. v1.21.9 solved the same shape on the backup path by running `qemu-img convert` via `sudo -u libvirt-qemu`. v2.0.3 generalises that fix into a `qemuImg()` helper in `safeExec.ts` and routes every VM-disk-touching qemu-img call through it: snapshot delete (running + stopped paths), snapshot revert, snapshot-export-to-template (both external and live paths), disk resize, getSnapshotSizeBytes, and the to-template flow's backing-chain probe. The existing `virtpilot ALL=(libvirt-qemu) NOPASSWD: /usr/bin/qemu-img` sudoers rule (added in v1.21.9) covers all of them. `qemu-img create` calls in `storageService` are unchanged — they write fresh files in already-virtpilot-owned directories. Pre-existing in v1.x — unrelated to the v2.0.0 UUID refactor — but fixed alongside the release.

## [2.0.2] — 2026-05-04

### Fixed

- **VM delete now tears down its iptables firewall chains and FORWARD jump rules.** Previously, `firewallService.deleteFirewallConfig` only unlinked the per-VM `*-firewall.json` config; the `VP-IN-${uuid8}` / `VP-OUT-${uuid8}` chains and the FORWARD jump rules pivoting on the VM's IP persisted. If the same IP later got allocated to a different VM, the orphaned rules would still match traffic to/from that IP. The delete handler now snapshots the VM's primary IP before undefine (from `vmMeta.networks[].ip` or live ARP) and calls `removeVmFirewall(uuid, ip)` to flush + drop the chains and remove the FORWARD jumps. Pre-existing in v1.x — unrelated to the v2.0.0 UUID refactor — but easy to fix while we were here.

## [2.0.1] — 2026-05-04

### Fixed

- **Rename failed with `domain 'X' is already defined with uuid Y`.** The v2.0.0 rename flow assumed `virsh define` on an existing `<uuid>` would update the domain's `<name>` element in place. It does not — libvirt rejects the redefine because the existing entry has a different name. Restored the v1-era `undefine --keep-nvram --snapshots-metadata` + `define` cycle: NVRAM (UUID-keyed) survives the cycle untouched, snapshot metadata is preserved, and the domain comes back under the new name with the same UUID. BIOS-firmware VMs that reject `--keep-nvram` fall back to a plain `undefine --snapshots-metadata`.

## [2.0.0] — 2026-05-04

### Changed

- **Storage paths are now keyed on a per-VM UUID instead of the user-typed name.** Every VM gets a `crypto.randomUUID()` at create time, injected into the libvirt domain XML's `<uuid>` element, and used as the storage identity across the whole system: `${vmsDir}/${uuid}/`, `${cloudInitDir}/${uuid}/`, NVRAM `${uuid}-nvram.fd`, cloud-init seed `${uuid}-seed.iso`, domain XML stash `${uuid}-domain.xml`, firewall iptables chains `VP-IN-${uuid8}` / `VP-OUT-${uuid8}` (uuid8 = first 8 hex chars of the UUID), `vm_metrics.vm_uuid` SQLite column, IP allocations, DHCP reservations, port-forwards, and backup directories `${backupRoot}/${uuid}/`. The libvirt domain `<name>` element stays the user-typed friendly label and is mutable via rename; the UUID is the immutable identity. Cloud-init `instance-id` now uses the UUID too, so cloud-init never re-runs user-data when the operator renames a VM. **Breaking change**: API routes `/api/vms/:name` → `/api/vms/:uuid`, backup routes `/api/backups/:vmName` → `/api/backups/:vmUuid`, WebSocket query param `?vm=<name>` → `?vm=<uuid>`. Frontend routes `/vms/:name` → `/vms/:uuid`.

### Fixed

- **The 409 "Storage directory for X already exists. Remove manually before retrying." error is gone.** Recreating a VM with the same friendly name as a previously deleted one used to collide with leftover storage; it now lands in a fresh UUID-keyed directory and never collides.
- **Rename collapses to a single `virsh define`.** The previous flow had to `undefine --keep-nvram` then redefine, plus rekey firewall chains, port-forwards, IP allocations, and SQLite metrics rows by name. With UUID-keyed storage, the libvirt domain (identified by its stable `<uuid>`) is updated in place with the new `<name>` element, the on-disk `name.txt` marker is rewritten, and the `vmMeta` record's `name` field is updated. Nothing else moves.

### Added

- **`name.txt` marker inside each `${vmsDir}/${uuid}/`** records the VM's current friendly name for operators sshing into the host. `ls $vmsDir` shows UUIDs; `cat $uuid/name.txt` maps each one back to its label without going through libvirt or the dashboard.
- **`subjectUuid` field on log entries** lets the Logs page group VM-scoped events across renames. The `subject` field continues to be the friendly name at write time, so the log line stays human-readable; `subjectUuid` carries the immutable identity.

## [1.22.0] — 2026-05-04

### Changed

- **`install.sh` no longer prompts for nginx — it is always installed.** The reverse proxy is the only sensible default (TLS termination, request streaming, large-upload handling, single public surface), and the prompt was a foot-gun: skipping it left the Node backend bound to `0.0.0.0:3001` directly, with no separation between TLS termination and application code. The `VP_NGINX=` env var, the TTY question, and the `USE_NGINX` branches in the closing summary are gone. Existing installs are unaffected — `update.sh` doesn't run install.sh — but every fresh install now lands on the nginx-fronted topology that v1.21.0 introduced.

### Added

- **Default NAT network "myNet" is seeded on fresh install.** Before today, a freshly installed dashboard had zero networks and the operator had to visit the Networks page and create one before any VM could get a NIC. `install.sh` now defines a libvirt NAT network (bridge `vp0`, CIDR `10.0.1.0/24`, gateway `10.0.1.1`, DHCP `10.0.1.2–10.0.1.254`, DNS `1.1.1.1` + `8.8.8.8`) and appends a matching entry to `/var/lib/virtpilot/networks.json` so the dashboard surfaces it immediately. The seed step is idempotent — re-running `install.sh` on an install that already has a `myNet` entry leaves it in place — and only fires on fresh installs (`update.sh` never runs install.sh).

## [1.21.11] — 2026-05-04

### Fixed

- **`sudo: unable to change to root gid: Operation not permitted` survived both v1.21.8 and v1.21.10.** v1.21.8 removed the explicit `NoNewPrivileges=true` from the unit; v1.21.10 dropped `CapabilityBoundingSet=`. Both fixes were aimed at the right symptom but missed the actual switch: per `systemd.exec(5)`, `RestrictSUIDSGID=true` *"implies `NoNewPrivileges=yes`, ignoring the value of [the explicit `NoNewPrivileges`] setting"*. So the kernel `no_new_privs` bit was still being set on every service start by the `RestrictSUIDSGID` line in the unit, the `setuid` bit on `/usr/bin/sudo` therefore did nothing, and sudo aborted in its init phase before it ever reached `qemu-img` — same error message regardless of which intermediate hardening line was removed. The v1.21.8 release shipped without ever exercising the in-app self-upgrade flow (which goes through `sudo systemd-run`); manual `sudo bash update.sh` from SSH masked the regression because that path is already root and never invokes setuid sudo. `RestrictSUIDSGID` is now omitted from the unit and stripped from any pre-existing live unit by `update.sh`. The protection it nominally offered was illusory in this service: it blocks *creating* setuid files, not *exec'ing* them, and the backend has no reason to `chmod +s` anything. Real isolation continues to come from `ProtectSystem=strict` + `ProtectKernel*` + `ReadWritePaths=/var/lib/virtpilot`.

## [1.21.10] — 2026-05-04

### Fixed

- **The v1.21.9 backup fix died inside sudo with `unable to change to root gid: Operation not permitted` and `error initializing audit plugin sudoers_audit`.** v1.21.0 pinned `CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW` on `virtpilot.service`. The bounding set persists across `execve`, so when the setuid-root sudo binary takes over it lacks `CAP_SETUID`, `CAP_SETGID` and `CAP_AUDIT_WRITE` — sudo's first `setgid(0)` and the audit plugin's `auditctl` calls both `EPERM` out, and the entire invocation aborts before it ever reaches `qemu-img`. Same root cause would silently break `sudo systemd-run` (in-app self-upgrade) and `sudo apt-get` (apt upgrade flow); v1.21.8 only removed `NoNewPrivileges`, not the bounding set, so those paths were one user-test away from the same wall. The bounding set now drops back to the systemd default — `ProtectSystem=strict` + `ProtectKernel*` + `ReadWritePaths` are still in force for the real isolation, and the blast-radius argument for pinning the bounding set is illusory anyway since the service already has sudo rights to apt-get/systemctl per `/etc/sudoers.d/virtpilot`. `update.sh` strips `CapabilityBoundingSet=` from any pre-existing live unit and runs `daemon-reload` before restart, so a one-time `sudo bash /usr/local/virtpilot/update.sh` heals an already-stuck install.

## [1.21.9] — 2026-05-04

### Fixed

- **Backups failed with `qemu-img: Could not open … Permission denied` for any VM that had ever been started.** v1.21.0 moved the backend off root onto the unprivileged `virtpilot` system user. While a VM is running (or was running and libvirt has not yet restored the original ownership), libvirt's `dynamic_ownership=1` chowns the qcow2 to `libvirt-qemu` mode 0600 — so the backend's own `qemu-img convert` call ran straight into EACCES. The v1.21.6 fix made libvirt-qemu a member of the `virtpilot` group, which solved the *forward* direction (libvirt-qemu traversing into virtpilot's storage tree); the reverse — virtpilot reading a libvirt-qemu-owned file — is not solvable by group membership when the file is mode 0600. `backupService` now invokes `qemu-img convert` via `sudo -n -u libvirt-qemu /usr/bin/qemu-img …`, gated by a tightly-scoped sudoers rule (`virtpilot ALL=(libvirt-qemu) NOPASSWD: /usr/bin/qemu-img`). The destination directory is bumped from 0755 to 0770 so libvirt-qemu (already in the `virtpilot` group) can write the converted qcow2 into the operator's backup tree without any further widening. `update.sh` adds the missing sudoers line on existing installs and `visudo`-validates the file before reload. No qemu.conf or libvirtd changes — every other path keeps running unprivileged.

## [1.21.8] — 2026-05-04

### Fixed

- **In-app self-upgrade failed with `sudo: The "no new privileges" flag is set, which prevents sudo from running as root`.** v1.21.0 added `NoNewPrivileges=true` to `virtpilot.service` for hardening, but the upgrade flow shells out to `sudo systemd-run --unit=virtpilot-update … bash update.sh` (and `apt upgrade` does `sudo apt-get`), and the kernel's `no_new_privs` bit makes sudo refuse to elevate even with the NOPASSWD rules in `/etc/sudoers.d/virtpilot`. The hardening was self-defeating: it broke the upgrade path while contributing nothing meaningful, since the iptables/ip-link surface that matters already runs via `CAP_NET_ADMIN` ambient capability rather than sudo. `install.sh` no longer writes the line; `update.sh` strips it from any pre-existing live unit and runs `daemon-reload` before restarting, so a one-time `sudo bash /usr/local/virtpilot/update.sh` from SSH heals an already-stuck install. All other hardening (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`, `RestrictRealtime`, `RestrictNamespaces`, `SystemCallArchitectures=native`) stays in force.

## [1.21.7] — 2026-05-04

### Security

- **Plaintext guest password no longer ships with every `/api/vms/<name>/meta` poll.** The Access card on the VM detail page used to receive the decrypted root password as part of the routine 10-second meta refresh, so the secret sat in the React Query cache, in nginx access logs that include response bodies, and in any browser devtools tab the operator had open. The password now lives behind a separate `/api/vms/<name>/credentials` endpoint that's only hit when the operator clicks the eye icon or the copy icon — the standing `/meta` payload no longer carries the secret at all. UI behaviour is unchanged for the operator.
- **Backup restore can no longer write disks outside `STORAGE_ROOT/vms/`.** `POST /api/backups/<vmName>/<backupId>/restore` accepted a `newVmName` body field that fed straight into `path.join(vmsDir, newVmName)`. A payload like `"../../etc/cron.d/x"` resolved outside `vmsDir` and the restore loop would happily copy the backup's qcow2 files into that arbitrary directory (whatever the `virtpilot` service user could touch). The restore handler now runs `validateVmName()` *before* any path math, so a traversal payload is rejected with HTTP 500 instead of being normalised by `path.join`.
- **Backup routes reject malformed `:backupId` URL params.** `GET`, `DELETE`, and `POST .../restore` all accepted any string as the backup id and passed it straight through `path.join(backupRoot, vmName, id)`. URL-encoded `..%2F` traversal worked because Express doesn't strip `..` from path params. All three endpoints now gate on the strict `^\d{8}T\d{6}Z-[0-9a-f]{6}$` shape that `backupId()` actually produces, so the `path.join` only ever sees a known-good leaf id.
- **WebSocket auth no longer accepts the legacy `?token=<jwt>` query param.** v1.21.0 moved console/SSH/VNC tokens to `Sec-WebSocket-Protocol: virtpilot.token.<jwt>` to keep them out of nginx logs, journalctl, and browser history, but the server kept honouring the old query-string form during the upgrade window. The fallback is gone — the dashboard already uses the header form, so anyone on a build older than v1.21.0 just needs to refresh.

## [1.21.6] — 2026-05-04

### Fixed

- **Clean install couldn't start any VM — `Cannot access storage file ... (as uid:64055, gid:994): Permission denied`.** `install.sh` chowned `/var/lib/virtpilot` to `virtpilot:virtpilot` mode 750, but QEMU runs as `libvirt-qemu` and that user wasn't in the `virtpilot` group, so it couldn't even traverse the storage tree to reach `vms/<name>/disk.qcow2`. libvirt's `dynamic_ownership` would have handled the disk file's own permissions, but path traversal failed first. The installer now adds `libvirt-qemu` to the `virtpilot` group and restarts `libvirtd` so the daemon picks up the new supplementary group before forking qemu. Existing installs: re-run `install.sh` (idempotent) or do `sudo usermod -aG virtpilot libvirt-qemu && sudo systemctl restart libvirtd` once.

## [1.21.5] — 2026-05-04

### Fixed

- **The v1.21.4 CORS fix didn't work behind nginx.** I checked `URL.host === req.headers.host` for same-origin, but nginx's `proxy_set_header Host $host` *strips the port* — so the backend saw `Host: 89.167.48.215` while the Origin URL still said `89.167.48.215:3001`. They never matched and the cors callback errored on every same-origin asset request, producing the same 500 + `text/html` symptoms as v1.21.3. CORS now compares hostnames only (`URL.hostname` against `req.headers.host` with the port stripped), which is correct regardless of whether the request arrives directly or via nginx. Also patched the bundled nginx vhost to use `$http_host` instead of `$host` so the backend sees the original `Host` header verbatim — defence in depth for future code that might genuinely care about the port.

## [1.21.4] — 2026-05-04

### Fixed

- **White page after a fresh v1.21 install — the JS bundle returned 500 and the CSS came back as `text/html`.** Two interacting bugs in the v1.21.0 hardening: (1) the new CORS middleware accepted requests only when `Origin` was on the `ALLOWED_ORIGINS` allow-list, but Vite's `<script crossorigin>` tag makes the browser send an `Origin` header even for same-origin module preloads — so the cors callback errored, Express returned 500 to the script request, and the SPA never mounted. The CSS request fell through to the SPA catch-all and came back with `text/html` for the same reason. CORS now treats any request whose `Origin` host matches the request's `Host` header as same-origin and allows it unconditionally; cross-origin still gates on `ALLOWED_ORIGINS`. (2) the CSP blocked the Google Fonts stylesheet (`fonts.googleapis.com`) and font files (`fonts.gstatic.com`) — secondary to the white page but cosmetic-broken on its own. CSP now allows both, plus an explicit `style-src-elem` so newer Chrome versions don't fall back to `style-src` with a warning.

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
