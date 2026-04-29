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
