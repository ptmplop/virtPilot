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
