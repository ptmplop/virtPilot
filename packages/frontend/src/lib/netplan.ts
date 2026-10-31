import type { Network } from '@/types';

// What to paste into a guest for a NIC added after it was created: cloud-init only
// ever configures the NICs a VM was created with.
export function buildNetplanSnippet(mac: string, network: Network, staticIp?: string): string {
  const prefix = network.cidr.split('/')[1];
  const isStatic = network.type !== 'nat' && network.ipMode === 'static' && staticIp;
  const lines = [
    'network:',
    '  version: 2',
    '  ethernets:',
    '    new-nic:',
    `      match:`,
    `        macaddress: "${mac}"`,
    `      set-name: eth1  # rename as needed`,
  ];
  if (network.type === 'vxlan') {
    lines.push(`      mtu: ${network.mtu}`);
    lines.push(`      optional: true`);
  }
  if (isStatic) {
    lines.push(`      addresses:`);
    lines.push(`        - ${staticIp}/${prefix}`);
    if (network.dns.length > 0) {
      lines.push(`      nameservers:`);
      lines.push(`        addresses: [${network.dns.map((d) => `"${d}"`).join(', ')}]`);
    }
  } else {
    lines.push(`      dhcp4: true`);
  }
  return lines.join('\n');
}
