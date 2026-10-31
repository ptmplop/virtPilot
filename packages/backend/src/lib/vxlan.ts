// Everything about a VXLAN that needs no access to the host: IDs, remote hosts,
// the libvirt network, the firewall rules, and what has to change to get from
// the tunnel the kernel has to the one that is wanted. services/vxlanService.ts
// does the talking to the host.
//
// What a VXLAN is here: an isolated libvirt network (libvirt owns the bridge, so
// it is back before any autostart VM at boot, and runs DHCP on it) with a kernel
// VXLAN device as a bridge port. VMs on the same host reach each other through
// the bridge alone.
//
// The device only comes up once there is a remote host to talk to. An up VXLAN
// device listens on UDP on every address of the host whatever `local` says, and
// takes any frame carrying its ID from anyone, straight onto the VMs' private
// network (measured from another machine on the internet). So: no remote hosts,
// device down, no socket at all. Remote hosts: the allow-list goes in first, and
// if it can't, the device stays down.

import { escapeXml, validateIpv4, validatePort } from './validate.js';

export const VNI_MIN = 1;
export const VNI_MAX = 16_777_215;
/** Where "next available" starts: low IDs are often taken by hand on a network that has VXLANs already. */
export const VNI_FIRST_AUTO = 100;
export const VXLAN_DEFAULT_PORT = 4789;
/** Outer IPv4 + UDP + VXLAN + inner Ethernet headers. */
export const VXLAN_OVERHEAD = 50;
/**
 * Two VLAN tags, kept free so a guest can tag inside its VXLAN (802.1Q or QinQ) at the
 * MTU its NIC reports. The bridge passes tags through as they are, and its forwarding
 * check leaves room for two (measured: it counts one against the MTU and carries the
 * other as metadata). Without this room a full-size tagged frame still gets across,
 * but as two fragments of an outer packet: slow, and lost on networks that drop them.
 */
export const VXLAN_TAG_ROOM = 8;
export const VXLAN_DEFAULT_MTU = 1500 - VXLAN_OVERHEAD - VXLAN_TAG_ROOM;
export const VXLAN_MTU_MIN = 576;
export const VXLAN_MTU_MAX = 9000;
export const VXLAN_PEERS_MAX = 64;
export const VXLAN_CHAIN = 'VP-VXLAN';
/** The one jump from INPUT. Other UDP falls straight through the chain and on down INPUT. */
export const VXLAN_JUMP = ['-p', 'udp', '-j', VXLAN_CHAIN] as const;
const FLOOD_MAC = '00:00:00:00:00:00';

/** Bad input from whoever is creating or editing a VXLAN, worded for them. */
export class VxlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VxlanInputError';
  }
}

export interface VxlanTunnel {
  vni: number;
  port: number;
  peers: string[];
  /** Up with no remote hosts, because it would not go down: it needs its DROP until it does. */
  stuckOpen?: boolean;
}

/** The kernel device. `vp` keeps it out of the host's network figures, like every managed bridge. */
export function vxlanDeviceName(vni: number): string {
  return `vpx${vni}`;
}

/**
 * Named after the ID, not numbered like vp0, vp1: `ip link` then reads as what it is,
 * and a name is never reused by a different network for a stopped VM to land on.
 */
export function vxlanBridgeName(vni: number): string {
  return `vpbr${vni}`;
}

/** A whole number, as a number or as text from a form. NaN for anything else: `true` is not 1 here. */
function wholeNumber(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : NaN;
}

export function parseVni(raw: unknown): number {
  const n = wholeNumber(raw);
  if (!Number.isInteger(n) || n < VNI_MIN || n > VNI_MAX) {
    throw new VxlanInputError(`A VXLAN ID is a whole number from ${VNI_MIN} to ${VNI_MAX}.`);
  }
  return n;
}

export function parseVxlanPort(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return VXLAN_DEFAULT_PORT;
  try {
    return validatePort(wholeNumber(raw));
  } catch {
    throw new VxlanInputError('The UDP port is a whole number from 1 to 65535.');
  }
}

export function parseVxlanMtu(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = wholeNumber(raw);
  if (!Number.isInteger(n) || n < VXLAN_MTU_MIN || n > VXLAN_MTU_MAX) {
    throw new VxlanInputError(`The MTU is a whole number from ${VXLAN_MTU_MIN} to ${VXLAN_MTU_MAX}.`);
  }
  return n;
}

/** What fits inside the host's own link with two VLAN tags, never more than a standard Ethernet network carries. */
export function defaultVxlanMtu(underlayMtu: number | null): number {
  if (!underlayMtu || !Number.isFinite(underlayMtu)) return VXLAN_DEFAULT_MTU;
  return Math.max(VXLAN_MTU_MIN, Math.min(VXLAN_DEFAULT_MTU, underlayMtu - VXLAN_OVERHEAD - VXLAN_TAG_ROOM));
}

/** The lowest free ID from `start` on, wrapping round to the low IDs before giving up. */
export function nextFreeVni(used: Iterable<number>, start = VNI_FIRST_AUTO): number | null {
  const taken = new Set(used);
  for (let v = start; v <= VNI_MAX; v++) if (!taken.has(v)) return v;
  for (let v = VNI_MIN; v < start; v++) if (!taken.has(v)) return v;
  return null;
}

/**
 * The remote hosts of a VXLAN: unicast IPv4 addresses, as an array or as text
 * separated by commas, spaces or new lines. Normalised, because `010.0.0.1`
 * means something different to each tool that reads it.
 */
export function parsePeers(raw: unknown, ownAddresses: readonly string[] = [], ownNetwork?: (ip: string) => boolean): string[] {
  let items: unknown[];
  if (raw === undefined || raw === null) items = [];
  else if (Array.isArray(raw)) items = raw;
  else if (typeof raw === 'string') items = raw.split(/[\s,]+/);
  else throw new VxlanInputError('Remote hosts must be a list of IPv4 addresses.');

  const peers: string[] = [];
  for (const item of items) {
    if (item === '') continue;
    let ip: string;
    try {
      ip = validateIpv4(item).split('.').map(Number).join('.');
    } catch {
      throw new VxlanInputError(`"${String(item)}" is not an IPv4 address. Remote hosts are given by address.`);
    }
    const [a] = ip.split('.').map(Number);
    if (a === 0 || a === 127 || a >= 224) {
      throw new VxlanInputError(`${ip} can't be a remote host: it is not an address a single machine can have.`);
    }
    if (ownAddresses.includes(ip)) {
      throw new VxlanInputError(`${ip} is this host. List the other hosts here.`);
    }
    if (ownNetwork?.(ip)) {
      throw new VxlanInputError(`${ip} is on this VXLAN itself, so its tunnel would have to run through itself. List an address on one of the host's own links.`);
    }
    if (!peers.includes(ip)) peers.push(ip);
  }
  if (peers.length > VXLAN_PEERS_MAX) {
    throw new VxlanInputError(`A VXLAN can have at most ${VXLAN_PEERS_MAX} remote hosts.`);
  }
  return peers;
}

// ─── libvirt ──────────────────────────────────────────────────────────────────

export interface VxlanNetworkXmlOptions {
  libvirtName: string;
  bridge: string;
  mtu: number;
  /** DHCP mode only: this host's address on the network and the range it hands out. */
  dhcp?: { address: string; prefix: number; start: string; end: string };
}

/**
 * No <forward>, so nothing routes off the network. <dns enable='no'/>: a VM on a
 * second network must not start asking this one for names it can't answer. With
 * those, libvirt's dnsmasq offers no router and no DNS, only an address and the
 * MTU, so this NIC never takes the default route from the VM's real uplink.
 */
export function vxlanNetworkXml(opts: VxlanNetworkXmlOptions): string {
  const ip = opts.dhcp
    ? `
  <ip address='${escapeXml(opts.dhcp.address)}' prefix='${Math.trunc(opts.dhcp.prefix)}'>
    <dhcp>
      <range start='${escapeXml(opts.dhcp.start)}' end='${escapeXml(opts.dhcp.end)}'/>
    </dhcp>
  </ip>`
    : '';
  return `<network>
  <name>${escapeXml(opts.libvirtName)}</name>
  <bridge name='${escapeXml(opts.bridge)}' stp='off' delay='0'/>
  <mtu size='${Math.trunc(opts.mtu)}'/>
  <dns enable='no'/>${ip}
</network>`;
}

// ─── Firewall ─────────────────────────────────────────────────────────────────

// The VXLAN header sits 8 bytes (UDP) into the IP payload, its ID in bytes 4-6.
// `0>>22&0x3C@` skips an IP header of any length. Matching the ID rather than the
// whole port leaves any other VXLAN software on the host alone, and means a host
// allowed on one VXLAN can't put frames on another.
export function vniMatch(vni: number): string {
  return `0>>22&0x3C@12>>8=${parseVni(vni)}`;
}

function tunnelRules(t: VxlanTunnel): string[] {
  const vni = vniMatch(t.vni);
  const port = validatePort(t.port);
  return [
    ...t.peers.map((p) => `-A ${VXLAN_CHAIN} -s ${validateIpv4(p)} -p udp -m udp --dport ${port} -m u32 --u32 "${vni}" -j ACCEPT`),
    `-A ${VXLAN_CHAIN} -p udp -m udp --dport ${port} -m u32 --u32 "${vni}" -j DROP`,
  ];
}

/** For `iptables-restore --noflush`: naming the chain empties it, and the swap is atomic. */
export function vxlanFirewallRestore(tunnels: readonly VxlanTunnel[]): string {
  const rules = tunnelsListening(tunnels).flatMap(tunnelRules);
  return ['*filter', `:${VXLAN_CHAIN} - [0:0]`, ...rules, 'COMMIT', ''].join('\n');
}

/** The tunnels with a socket open, which are the ones that need rules. */
export function tunnelsListening(tunnels: readonly VxlanTunnel[]): VxlanTunnel[] {
  return tunnels.filter((t) => t.peers.length > 0 || t.stuckOpen);
}

// ─── Reading the host ─────────────────────────────────────────────────────────

export interface VxlanLink {
  name: string;
  vni: number;
  port: number;
  mtu: number;
  master?: string;
  up: boolean;
  rxBytes: number;
  txBytes: number;
}

/** `ip -d -s -j link show type vxlan`. Unreadable output reads as no devices. */
export function parseVxlanLinks(json: string): VxlanLink[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const links: VxlanLink[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const info = (entry.linkinfo as { info_data?: { id?: unknown; port?: unknown } } | undefined)?.info_data;
    if (typeof entry.ifname !== 'string' || typeof info?.id !== 'number') continue;
    const stats = entry.stats64 as { rx?: { bytes?: number }; tx?: { bytes?: number } } | undefined;
    links.push({
      name: entry.ifname,
      vni: info.id,
      port: typeof info.port === 'number' ? info.port : VXLAN_DEFAULT_PORT,
      mtu: typeof entry.mtu === 'number' ? entry.mtu : 0,
      master: typeof entry.master === 'string' ? entry.master : undefined,
      up: Array.isArray(entry.flags) && entry.flags.includes('UP'),
      rxBytes: stats?.rx?.bytes ?? 0,
      txBytes: stats?.tx?.bytes ?? 0,
    });
  }
  return links;
}

export interface FdbView {
  /** Remote hosts this device floods to: all-zeros entries. */
  floodPeers: string[];
  /** Machines learned behind each remote host, which means frames have arrived from it. */
  learned: Map<string, number>;
}

const ipNum = (ip: string): number => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
const numIp = (n: number): string => [24, 16, 8, 0].map((bits) => Math.floor(n / 2 ** bits) % 256).join('.');

/** The DHCP range of a network: everything usable but the host's own address, when it sits at either end. */
export function dhcpRange(first: string, last: string, hostAddress: string): { start: string; end: string } {
  return {
    start: hostAddress === first ? numIp(ipNum(first) + 1) : first,
    end: hostAddress === last ? numIp(ipNum(last) - 1) : last,
  };
}

/** `bridge -j fdb show dev <device>`. The bridge's own entries carry no `dst` and are skipped. */
export function parseFdb(json: string): FdbView {
  const view: FdbView = { floodPeers: [], learned: new Map() };
  let raw: unknown;
  try {
    raw = JSON.parse(json || '[]');
  } catch {
    return view;
  }
  if (!Array.isArray(raw)) return view;
  for (const entry of raw as Array<{ mac?: unknown; dst?: unknown }>) {
    if (typeof entry.dst !== 'string' || typeof entry.mac !== 'string') continue;
    if (entry.mac === FLOOD_MAC) {
      if (!view.floodPeers.includes(entry.dst)) view.floodPeers.push(entry.dst);
    } else {
      view.learned.set(entry.dst, (view.learned.get(entry.dst) ?? 0) + 1);
    }
  }
  return view;
}

// ─── Getting there ────────────────────────────────────────────────────────────

export interface TunnelWanted extends VxlanTunnel {
  mtu: number;
  /** null: the bridge doesn't exist right now, so there is nothing to attach to. */
  bridge: string | null;
  /** False when the firewall rules are not in force: the device stays down whatever else is true. */
  allowUp: boolean;
}

export interface TunnelStep {
  tool: 'ip' | 'bridge';
  args: string[];
}

export interface TunnelPlan {
  /** Someone else's device has this name: touch nothing and say so. */
  conflict?: string;
  steps: TunnelStep[];
}

const ip = (...args: string[]): TunnelStep => ({ tool: 'ip', args });
const fdb = (verb: 'append' | 'del', device: string, peer: string): TunnelStep => ({
  tool: 'bridge',
  args: ['fdb', verb, FLOOD_MAC, 'dev', device, 'dst', peer],
});

/**
 * The commands from `have` to `want`, in an order that is safe to stop half way
 * through: anything closing the tunnel comes first and bringing it up comes last,
 * so it is never up with stale settings.
 *
 * No `local`: the kernel then picks the source address per remote host from the
 * routing table, which is right on a host with a private network for its tunnels
 * and stays right when the host's address changes.
 */
export function planTunnel(want: TunnelWanted, have: VxlanLink | undefined, havePeers: readonly string[]): TunnelPlan {
  const device = vxlanDeviceName(want.vni);
  if (have && (have.vni !== want.vni || have.port !== want.port)) {
    return {
      conflict: `Interface ${device} on this host is VXLAN ID ${have.vni} on port ${have.port}, not ID ${want.vni} on port ${want.port}. Remove it (ip link delete ${device}) and VirtPilot will put the right one back.`,
      steps: [],
    };
  }

  const shouldBeUp = want.allowUp && want.peers.length > 0 && want.bridge !== null;
  const steps: TunnelStep[] = [];

  if (have?.up && !shouldBeUp) steps.push(ip('link', 'set', device, 'down'));
  if (!have) steps.push(ip('link', 'add', device, 'type', 'vxlan', 'id', String(want.vni), 'dstport', String(want.port)));
  if (!have || have.mtu !== want.mtu) steps.push(ip('link', 'set', device, 'mtu', String(want.mtu)));
  if (want.bridge && have?.master !== want.bridge) steps.push(ip('link', 'set', device, 'master', want.bridge));

  for (const peer of havePeers) if (!want.peers.includes(peer)) steps.push(fdb('del', device, peer));
  for (const peer of want.peers) if (!havePeers.includes(peer)) steps.push(fdb('append', device, peer));

  if (shouldBeUp && !have?.up) steps.push(ip('link', 'set', device, 'up'));
  return { steps };
}
