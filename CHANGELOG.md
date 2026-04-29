# Changelog

All notable changes to VirtPilot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
