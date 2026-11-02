// A VM's firewall at its tap device, where a guest can't step around it. iptables in FORWARD sees
// only what is routed through this host, and only by address, which a guest chooses: a frame that
// crosses a bridge from one port to another never reaches it without br_netfilter (measured: a DROP
// on both addresses, ping passes, 0 packets through the chain), and a guest using an address the host
// doesn't know goes past its rules. Turning br_netfilter on would send every bridge through iptables.
//
// nftables' bridge family filters per port instead, with nothing else on the host going through it.
// Each VM has a chain per direction, and two maps send a frame to them by the tap it left or
// arrived on, whatever addresses are in it. A flood copy is filtered like any other: an
// address-keyed rule misses a frame sent to the broadcast MAC with the guest's IP inside, which
// Linux guests accept. Three hooks: from one port to another, from the host's IP stack to a port
// (routed traffic in, and DNAT'd forwards), and from a port up to it (routed traffic out). What the
// host itself says to a guest, and what a guest says to the host, are left alone, as in FORWARD:
// DHCP, DNS from the host's dnsmasq, the SSH console.

import { validateIcmpType, validateIpv4, validateIpv4OrCidr, validateNicName, validatePortRange, validateProtocol } from './validate.js';
import type { FirewallConfig, FirewallRule } from '../services/firewallService.js';

export const FILTER_TABLE = 'bridge virtpilot';

export function chainsFor(short: string): { inChain: string; outChain: string } {
  if (!/^[0-9a-f]{8}$/.test(short)) throw new Error('Invalid VM id');
  return { inChain: `vp-in-${short}`, outChain: `vp-out-${short}` };
}

/**
 * The table, its hooks and the host's own addresses. Safe to repeat, and part of every script, as a
 * host restart empties it. A frame from or to one of the host's IPv4 addresses is the host's own
 * business: IPv4 drops anything that arrives claiming one as its source, so nothing forwarded can.
 * IPv6 doesn't: a packet claiming a host address would be forwarded and pass, and even a link-local
 * source is forwarded when it goes back out the way it came (measured). So over IPv6 the host gets no
 * pass beyond what every chain lets through, neighbour discovery and DHCPv6. A port forward the host translated so the
 * guest sees the gateway also has a host address on it: FORWARD filters that one, on the forward's
 * address, which always has a jump.
 */
export function tableScript(hostAddrs: readonly string[]): string[] {
  const addrs = [...new Set(hostAddrs.map((a) => validateIpv4(a)))];
  return [
    `add table ${FILTER_TABLE}`,
    `add map ${FILTER_TABLE} to_vm { type ifname : verdict ; }`,
    `add map ${FILTER_TABLE} from_vm { type ifname : verdict ; }`,
    `add set ${FILTER_TABLE} host_v4 { type ipv4_addr ; }`,
    `flush set ${FILTER_TABLE} host_v4`,
    ...(addrs.length > 0 ? [`add element ${FILTER_TABLE} host_v4 { ${addrs.join(', ')} }`] : []),
    `add chain ${FILTER_TABLE} forward { type filter hook forward priority filter ; policy accept ; }`,
    `flush chain ${FILTER_TABLE} forward`,
    // Both directions, as a frame between two VMs answers to both. So a chain has to fall through
    // to let a frame pass: `accept` here would end the other VM's say in it.
    `add rule ${FILTER_TABLE} forward iifname vmap @from_vm`,
    `add rule ${FILTER_TABLE} forward oifname vmap @to_vm`,
    `add chain ${FILTER_TABLE} output { type filter hook output priority filter ; policy accept ; }`,
    `flush chain ${FILTER_TABLE} output`,
    `add rule ${FILTER_TABLE} output ip saddr @host_v4 accept`,
    `add rule ${FILTER_TABLE} output oifname vmap @to_vm`,
    `add chain ${FILTER_TABLE} input { type filter hook input priority filter ; policy accept ; }`,
    `flush chain ${FILTER_TABLE} input`,
    `add rule ${FILTER_TABLE} input ip daddr @host_v4 accept`,
    `add rule ${FILTER_TABLE} input iifname vmap @from_vm`,
  ];
}

// What a NIC needs to have a network at all, which rules were never about. ARP and the like pass as
// they do in FORWARD, which only ever sees IP. DHCP from a LAN's server: a renewal goes by unicast
// and is refused under a default of drop, so the guest falls back to broadcast, which passes. Both
// ways small and at a few frames a second, as these ports are otherwise a channel through any rule.
// A frame tagged in the guest goes on to the rules: they can't see inside it, so it gets the default.
const ETHER_PASS = 'ether type != { ip, ip6, 8021q, 8021ad } return';
const DHCP_SIZE = 'meta length <= 1100';
const ALWAYS_IN = [
  ETHER_PASS,
  `udp sport 67 udp dport 68 ${DHCP_SIZE} limit rate 10/second burst 20 packets return`,
  `udp sport 547 udp dport 546 ${DHCP_SIZE} limit rate 10/second burst 20 packets return`,
  'icmpv6 type { nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert, nd-redirect, mld-listener-query } return',
];
const ALWAYS_OUT = [
  ETHER_PASS,
  `ether daddr ff:ff:ff:ff:ff:ff udp sport 68 udp dport 67 ${DHCP_SIZE} limit rate 10/second burst 20 packets return`,
  `ether daddr & 01:00:00:00:00:00 == 01:00:00:00:00:00 udp sport 546 udp dport 547 ${DHCP_SIZE} limit rate 10/second burst 20 packets return`,
  'icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert, mld-listener-report, mld2-listener-report, mld-listener-done } return',
];

function portMatch(protocol: 'tcp' | 'udp', portRange: string): string {
  const ports = validatePortRange(portRange).replace(/:/g, '-').split(',');
  return `${protocol} dport ${ports.length > 1 ? `{ ${ports.join(', ')} }` : ports[0]}`;
}

/** What a rule matches, in the same terms as its iptables twin. Without an address it holds for IPv6 too; rules can only name IPv4 ones. */
export function ruleMatch(rule: FirewallRule): string[] {
  const parts: string[] = [];
  if (rule.direction === 'inbound' && rule.source) parts.push(`ip saddr ${validateIpv4OrCidr(rule.source)}`);
  if (rule.direction === 'outbound' && rule.destination) parts.push(`ip daddr ${validateIpv4OrCidr(rule.destination)}`);
  const v4Only = parts.length > 0;
  const proto = validateProtocol(rule.protocol);
  if (proto === 'tcp' || proto === 'udp') {
    parts.push(rule.portRange ? portMatch(proto, rule.portRange) : `meta l4proto ${proto}`);
  } else if (proto === 'icmp') {
    if (rule.icmpType) {
      const [type, code] = validateIcmpType(rule.icmpType).split('/');
      parts.push(`icmp type ${type}`, ...(code !== undefined ? [`icmp code ${code}`] : []));
    } else {
      parts.push(v4Only ? 'ip protocol icmp' : 'meta l4proto { icmp, ipv6-icmp }');
    }
  }
  return parts;
}

/** One rule, untracked: an allow only falls through, so the other end of a frame still has its say. */
export function ruleToNft(rule: FirewallRule): string {
  return [...ruleMatch(rule), rule.action === 'allow' ? 'return' : 'drop'].join(' ');
}

const hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`;

/**
 * A VM's two chains, replaced whole. Goes in one transaction with whatever else is in the script.
 *
 * Every connection through them is tracked, which also has the bridge put fragments back together
 * before the rules see them: a fragment after the first has no ports, and a guest could otherwise
 * send lone ones through a default of drop. On a bridge a guest can also make up the first frame of a
 * connection: one claiming to come from a VM, sent to a third port, makes the guest's next frame to
 * that VM look like a reply. So a connection is marked with who started it (the top half of its
 * mark, set where it leaves a VM) and who let it in (the bottom half, set where a VM's rules allowed
 * it), and "established" counts only the connections this VM started, coming in, and those it let
 * in, going out, with the ICMP errors about either. A fragment the host's routing made, after its own
 * reassembly, carries its connection's mark and passes on it. `mark` is this VM's number, 1 to 65535,
 * unique on the host.
 */
export function vmChainsScript(short: string, cfg: FirewallConfig, mark: number): string[] {
  const { inChain, outChain } = chainsFor(short);
  if (!(Number.isInteger(mark) && mark >= 1 && mark <= 0xffff)) throw new Error('A firewall at the tap needs its mark');
  const started = hex(mark * 0x10000);
  const allowed = hex(mark);
  const letIn = ` ct mark set ct mark & 0xffff0000 | ${allowed}`;
  const fragments = (half: string, value: string) => [`ip frag-off & 0x1fff != 0 ct mark & ${half} == ${value} return`, `frag frag-off != 0 ct mark & ${half} == ${value} return`];
  const inRules = [
    ...ALWAYS_IN,
    ...fragments('0xffff0000', started),
    ...fragments('0x0000ffff', allowed),
    ...(cfg.allowEstablishedInbound ? [`ct state established,related ct mark & 0xffff0000 == ${started} return`, `ct state related ct mark & 0x0000ffff == ${allowed} return`] : []),
    ...cfg.rules.filter((r) => r.direction === 'inbound').map((r) => (r.action === 'allow' ? `${ruleMatch(r).join(' ')}${letIn} return`.trim() : ruleToNft(r))),
    ...(cfg.defaultInbound === 'drop' ? ['drop'] : [letIn.trim()]),
  ];
  const outRules = [
    ...ALWAYS_OUT,
    `ct state new ct mark set ct mark & 0x0000ffff | ${started}`,
    ...fragments('0xffff0000', started),
    ...fragments('0x0000ffff', allowed),
    ...(cfg.allowEstablishedOutbound ? [`ct state established,related ct mark & 0x0000ffff == ${allowed} return`, `ct state related ct mark & 0xffff0000 == ${started} return`] : []),
    ...cfg.rules.filter((r) => r.direction === 'outbound').map(ruleToNft),
    ...(cfg.defaultOutbound === 'drop' ? ['drop'] : []),
  ];
  const chain = (name: string, lines: readonly string[]) => [
    `add chain ${FILTER_TABLE} ${name}`,
    `flush chain ${FILTER_TABLE} ${name}`,
    ...lines.map((line) => `add rule ${FILTER_TABLE} ${name} ${line}`),
  ];
  return [...chain(inChain, inRules), ...chain(outChain, outRules)];
}

/** Sends these taps to this VM's chains, and stops sending those. Whoever a tap's name last belonged to, it is this VM's now. */
export function portsScript(short: string, add: readonly string[], remove: readonly string[] = []): string[] {
  const { inChain, outChain } = chainsFor(short);
  const lines: string[] = [];
  for (const raw of [...new Set([...add, ...remove])]) {
    const tap = validateNicName(raw);
    lines.push(`destroy element ${FILTER_TABLE} to_vm { "${tap}" }`, `destroy element ${FILTER_TABLE} from_vm { "${tap}" }`);
  }
  for (const raw of add) {
    const tap = validateNicName(raw);
    lines.push(`add element ${FILTER_TABLE} to_vm { "${tap}" : jump ${inChain} }`, `add element ${FILTER_TABLE} from_vm { "${tap}" : jump ${outChain} }`);
  }
  return lines;
}

/** Takes a VM out: its taps first, as a chain something jumps to can't be deleted. */
export function removeVmScript(short: string, taps: readonly string[]): string[] {
  const { inChain, outChain } = chainsFor(short);
  return [
    ...portsScript(short, [], taps),
    `delete chain ${FILTER_TABLE} ${inChain}`,
    `delete chain ${FILTER_TABLE} ${outChain}`,
  ];
}

export interface FilterState {
  /** Tap to the VM's id, from the chain a frame leaving by it goes to. */
  ports: Map<string, string>;
  chains: Set<string>;
}

/** `nft -j list table`. Empty if the table isn't there, which is the state after a host restart. */
export function parseFilterState(json: string): FilterState {
  const state: FilterState = { ports: new Map(), chains: new Set() };
  let items: Array<Record<string, { name?: string; elem?: unknown[] }>>;
  try {
    items = (JSON.parse(json) as { nftables?: typeof items }).nftables ?? [];
  } catch {
    return state;
  }
  for (const item of items) {
    if (item.chain?.name) state.chains.add(item.chain.name);
    if (item.map?.name !== 'to_vm') continue;
    for (const elem of item.map.elem ?? []) {
      const [tap, verdict] = elem as [string, { jump?: { target?: string } }];
      const short = verdict?.jump?.target?.match(/^vp-in-([0-9a-f]{8})$/)?.[1];
      if (short) state.ports.set(tap, short);
    }
  }
  return state;
}
