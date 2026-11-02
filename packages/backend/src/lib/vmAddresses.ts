// Reading a VM's addresses out of virsh's tables. A VM on a VXLAN has more than
// one NIC as a matter of course, so "the first address printed" stopped being a
// usable answer: it can be the guest's loopback, or a network this host has no
// route to.

const IPV4 = /^(\d{1,3}(?:\.\d{1,3}){3})\/\d+$/;
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const NO_MAC = '00:00:00:00:00:00';

export interface NicAddress {
  mac: string;
  ip: string;
}

/**
 * `virsh domifaddr`: one row per address, a second address on a NIC printing `-`
 * for its name and MAC. Loopback is dropped. Only IPv4: every caller wants an
 * address to put in an iptables rule or to connect to.
 */
export function parseDomIfAddr(output: string): NicAddress[] {
  const found: NicAddress[] = [];
  let mac = '';
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    if (MAC.test(parts[1])) mac = parts[1].toLowerCase();
    else if (parts[1] !== '-') continue;
    if (parts[2] !== 'ipv4' || !mac || mac === NO_MAC) continue;
    const ip = parts[3].match(IPV4)?.[1];
    if (ip && !ip.startsWith('127.')) found.push({ mac, ip });
  }
  return found;
}

/** `virsh net-dhcp-leases`: MAC to address, the newest row winning. */
export function parseDhcpLeases(output: string): Map<string, string> {
  const leases = new Map<string, string>();
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const mac = parts.find((p) => MAC.test(p));
    const ip = parts.map((p) => p.match(IPV4)?.[1]).find(Boolean);
    if (mac && ip) leases.set(mac.toLowerCase(), ip);
  }
  return leases;
}

/** The primary NIC's address when it is there, otherwise the first one found. */
export function pickVmIp(addresses: readonly NicAddress[], primaryMac?: string): string | null {
  const primary = primaryMac?.toLowerCase();
  const own = primary ? addresses.find((a) => a.mac === primary) : undefined;
  return own?.ip ?? addresses[0]?.ip ?? null;
}

/**
 * `ip -4 neigh show dev <bridge>`: what the host has heard from on that bridge lately. Not STALE:
 * on a quiet host that can outlast a deleted VM until reboot, and an address in this list isn't
 * offered, with no way to type it in. Whoever really holds one is found when it is taken. An entry
 * with no MAC was asked for and never answered.
 */
export function parseNeighbours(output: string, { stale = false } = {}): NicAddress[] {
  const states = stale ? 'REACHABLE|DELAY|PROBE|PERMANENT|STALE' : 'REACHABLE|DELAY|PROBE|PERMANENT';
  return [...output.matchAll(new RegExp(`^(\\d{1,3}(?:\\.\\d{1,3}){3}) lladdr ([0-9a-f]{2}(?::[0-9a-f]{2}){5})\\b.*\\b(?:${states})\\s*$`, 'gim'))]
    .map(([, ip, mac]) => ({ ip, mac: mac.toLowerCase() }));
}

/**
 * Who answered `arping -D` for this address. Only a reply naming it counts: the other `arping`
 * package on Debian and Ubuntu reads the same options differently and exits 1 for nobody, and an
 * address that looks taken when it isn't would stop a VM being made.
 */
export function parseArpingReply(output: string, ip: string): string | null {
  const m = output.match(/reply from (\S+) \[([0-9a-f]{2}(?::[0-9a-f]{2}){5})\]/i);
  return m && m[1] === ip ? m[2].toLowerCase() : null;
}
