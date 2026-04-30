# Changelog

All notable changes to VirtPilot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
