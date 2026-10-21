// A plain-text description of a host's passthrough state, to paste into a bug
// report. It is meant to travel (a public issue tracker), so it carries no
// addresses, hostnames or VM names: only the hardware and what VirtPilot made
// of it.

import type { HostFacts } from './hostFacts.js';
import type { Inventory } from './hostDevices.js';

const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g;
// Hex groups and colons, empty groups allowed (fd00:1234::1/64). MAC addresses match too, which is
// fine: they identify a machine just as well.
const IPV6_RE = /(?<![0-9a-f:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?(?![0-9a-f:])/gi;

/** Strip network addresses from free text (hidden-device reasons quote the host's address). */
export function scrubAddresses(text: string): string {
  // PCI addresses (0000:3b:00.0) look like IPv6 to a loose pattern; keep them.
  return text
    .replace(IPV4_RE, '<address>')
    .replace(IPV6_RE, (m) => (/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}$/i.test(m) || /^\d{1,2}:\d{2}:\d{2}$/.test(m) ? m : '<address>'));
}

const CMDLINE_KEEP_RE = /(?:^|\s)((?:intel_iommu|amd_iommu|iommu|intremap|pcie_acs_override|vfio[-_.][\w.-]*|modprobe\.blacklist|video|initcall_blacklist|kvm[-_.][\w.-]*)=\S+)/g;

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`;
}

export function buildPassthroughReport(inv: Inventory, facts: HostFacts, version: string): string {
  const out: string[] = [];
  out.push(`VirtPilot ${version} passthrough report`);
  out.push(`Kernel ${facts.kernel}; ${facts.cpu.model}; ${facts.cpu.vendor === 'intel' ? 'Intel' : facts.cpu.vendor === 'amd' ? 'AMD' : 'other'} CPU`);
  out.push(`ACPI: DMAR ${facts.acpi.dmar ? 'present' : 'absent'}, IVRS ${facts.acpi.ivrs ? 'present' : 'absent'}; /dev/kvm ${facts.kvm ? 'present' : 'absent'}`);
  const flags = [...facts.cmdline.matchAll(CMDLINE_KEEP_RE)].map((m) => m[1]);
  out.push(`Kernel flags: ${flags.length ? flags.join(' ') : 'none relevant'}`);
  out.push('');
  out.push('Host checks:');
  for (const c of inv.host.checks) out.push(`  ${c.label}: ${c.value}${c.fix ? ` (${c.fix})` : ''}`);
  out.push('');

  const vmNames = new Map<string, string>();
  const vmLabel = (uuid: string) => {
    if (!vmNames.has(uuid)) vmNames.set(uuid, `VM ${vmNames.size + 1}`);
    return vmNames.get(uuid)!;
  };

  out.push(`Offered for passthrough (${inv.devices.length}):`);
  for (const d of inv.devices) {
    const pci = d.type === 'pci' ? facts.pci.find((p) => p.address === d.address) : undefined;
    const parts = [
      d.type === 'pci' ? d.address : d.address.replace(/^Bus (\d+) Device (\d+)$/, 'usb $1:$2'),
      d.kindLabel,
      // lspci's own names, which is what anyone reading a bug report will search for.
      pci ? `${pci.vendorName ?? d.vendor} ${pci.deviceName ?? d.name}` : `${d.vendor} ${d.name}`,
      `[${d.vendorId}:${d.productId}]`,
    ];
    if (pci) {
      parts.push(`class ${pci.classCode}`);
      if (pci.iommuGroup !== undefined) parts.push(`group ${pci.iommuGroup}`);
      parts.push(`driver ${pci.driver ?? 'none'}`);
      if (pci.memoryBars.length) parts.push(`BARs ${pci.memoryBars.map(bytes).join(', ')}`);
      if (pci.resetMethods) parts.push(`reset ${pci.resetMethods.join(',') || 'none'}`);
      if (pci.sriovTotalVfs) parts.push(`SR-IOV ${pci.sriovNumVfs ?? 0}/${pci.sriovTotalVfs}`);
      if (pci.bootVga) parts.push('boot VGA');
    }
    if (d.members.length) parts.push(`with ${d.members.map((m) => m.address).join(', ')}`);
    if (d.kept) parts.push('kept for VMs');
    if (d.usedBy.length) parts.push(`given to ${d.usedBy.map((v) => `${vmLabel(v.uuid)}${v.running ? ' (running)' : ''}`).join(', ')}`);
    out.push(`  ${parts.join(' | ')}`);
    for (const n of d.notes) out.push(`      ${n.tone === 'warn' ? 'Attention' : 'Note'}: ${scrubAddresses(n.text)}`);
  }
  out.push('');

  const counts = new Map<string, number>();
  for (const h of inv.hidden) counts.set(h.category, (counts.get(h.category) ?? 0) + 1);
  out.push(`Not offered (${inv.hidden.length}: ${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ')}):`);
  for (const h of inv.hidden.filter((x) => x.category === 'host')) {
    out.push(`  ${h.type === 'pci' ? h.address : h.address.replace(/^Bus (\d+) Device (\d+)$/, 'usb $1:$2')} | ${h.vendor} ${h.name} | ${scrubAddresses(h.reason)}`);
  }
  out.push('');

  if (facts.journal.length) {
    out.push('Kernel messages (IOMMU, VFIO, virtualisation):');
    for (const l of facts.journal.slice(-25)) out.push(`  ${scrubAddresses(l)}`);
  } else {
    out.push('Kernel messages: not readable');
  }
  return `${out.join('\n')}\n`;
}
