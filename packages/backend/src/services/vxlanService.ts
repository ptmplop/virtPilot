// The host side of a VXLAN: the libvirt network that owns its bridge, the kernel
// device, the remote hosts it floods to and the firewall rules that guard it. All
// of it runs under the service's own CAP_NET_ADMIN (ip, bridge, iptables; the
// kernel loads the vxlan and xt_u32 modules itself), so no sudo rule and no root
// helper is involved. The decisions are in lib/vxlan.ts; networkService owns the
// records and calls in here with them.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  VXLAN_CHAIN,
  VXLAN_JUMP,
  parseFdb,
  parseVxlanLinks,
  planTunnel,
  tunnelsListening,
  vxlanDeviceName,
  vxlanFirewallRestore,
  type VxlanLink,
  type VxlanTunnel,
} from '../lib/vxlan.js';
import { bridgeExists, plainError, reconnectIfRebuilt, restoreBridge } from './libvirtBridge.js';
import { run, runSafe } from './safeExec.js';
import type { Network } from './networkService.js';

export type VxlanNetwork = Network & Required<Pick<Network, 'vni' | 'vxlanPort' | 'mtu' | 'peers' | 'libvirtName'>>;

export function isVxlan(n: Network): n is VxlanNetwork {
  return n.type === 'vxlan';
}

function tunnelOf(n: VxlanNetwork): VxlanTunnel {
  return { vni: n.vni, port: n.vxlanPort, peers: n.peers };
}

// ─── Firewall ─────────────────────────────────────────────────────────────────

const WAIT = ['-w', '5'];

async function removeFirewall(): Promise<void> {
  // -S first: a host with no remote hosts anywhere is the common case, and it
  // should cost nothing and leave no trace.
  if ((await runSafe('iptables', [...WAIT, '-S', VXLAN_CHAIN])) === null) return;
  while ((await runSafe('iptables', [...WAIT, '-D', 'INPUT', ...VXLAN_JUMP])) !== null) { /* one per apply, but be sure */ }
  await runSafe('iptables', [...WAIT, '-F', VXLAN_CHAIN]);
  await runSafe('iptables', [...WAIT, '-X', VXLAN_CHAIN]);
}

/**
 * Null when the rules are in force, or the reason they are not. Written afresh on every
 * pass, not only when they seem to have changed: the swap is atomic, and something that
 * put back an old ruleset of the same size would otherwise go unnoticed, with a removed
 * host still allowed.
 */
async function syncFirewall(tunnels: readonly VxlanTunnel[]): Promise<string | null> {
  if (tunnelsListening(tunnels).length === 0) {
    await removeFirewall();
    return null;
  }
  const file = path.join(os.tmpdir(), `vp-vxlan-${randomUUID()}.rules`);
  try {
    await fs.writeFile(file, vxlanFirewallRestore(tunnels), 'utf8');
    // The chain is filled before anything jumps to it, and replaced in one step.
    await run('iptables-restore', [...WAIT, '--noflush', file]);
    if ((await runSafe('iptables', [...WAIT, '-C', 'INPUT', ...VXLAN_JUMP])) === null) {
      await run('iptables', [...WAIT, '-I', 'INPUT', '1', ...VXLAN_JUMP]);
    }
    return null;
  } catch (err) {
    return `The firewall rules that guard the tunnel could not be applied, so it stays down. Check that this host's kernel has the xt_u32 module (modprobe xt_u32). The error: ${plainError(err)}`;
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

// ─── Reading the host ─────────────────────────────────────────────────────────

export async function readVxlanLinks(): Promise<VxlanLink[]> {
  return parseVxlanLinks((await runSafe('ip', ['-d', '-s', '-j', 'link', 'show', 'type', 'vxlan'])) ?? '[]');
}

async function readFdb(device: string) {
  return parseFdb((await runSafe('bridge', ['-j', 'fdb', 'show', 'dev', device])) ?? '[]');
}

/** Without running anything: a host with no VXLANs should pay nothing for this feature. */
export async function anyVxlanDevice(): Promise<boolean> {
  const names = await fs.readdir('/sys/class/net').catch(() => [] as string[]);
  return names.some((n) => OUR_DEVICE.test(n));
}

export async function interfaceExists(name: string): Promise<boolean> {
  return (await runSafe('ip', ['link', 'show', 'dev', name])) !== null;
}

export async function hostAddresses(): Promise<string[]> {
  try {
    const raw = JSON.parse(await run('ip', ['-4', '-j', 'addr', 'show'])) as Array<{ addr_info?: Array<{ local?: string }> }>;
    return raw.flatMap((i) => (i.addr_info ?? []).map((a) => a.local).filter((a): a is string => !!a));
  } catch {
    return [];
  }
}

/** The address this host sends from towards `dest`: what the far end has to list. */
async function sourceAddressTowards(dest: string): Promise<string | null> {
  try {
    const [route] = JSON.parse(await run('ip', ['-j', 'route', 'get', dest])) as Array<{ prefsrc?: string }>;
    return route?.prefsrc ?? null;
  } catch {
    return null;
  }
}

/** The MTU of the link the default route uses, or null on a host without one. */
export async function underlayMtu(): Promise<number | null> {
  try {
    const [route] = JSON.parse(await run('ip', ['-j', 'route', 'show', 'default'])) as Array<{ dev?: string }>;
    if (!route?.dev) return null;
    const [link] = JSON.parse(await run('ip', ['-j', 'link', 'show', 'dev', route.dev])) as Array<{ mtu?: number }>;
    return link?.mtu ?? null;
  } catch {
    return null;
  }
}

// ─── Making the host match ────────────────────────────────────────────────────

const OUR_DEVICE = /^vpx\d+$/;
const lastProblems = new Map<string, string[]>();

/**
 * Make the host match the records: firewall first, then every network's bridge,
 * device and remote hosts. Safe to run at any time and cheap when nothing has
 * changed. A device is only ever brought up behind firewall rules in force.
 * Returns what went wrong, by network, and keeps it for the status page.
 */
export async function syncVxlanNetworks(networks: readonly Network[]): Promise<Map<string, string[]>> {
  const vxlans = networks.filter(isVxlan);
  const problems = new Map<string, string[]>();
  lastProblems.clear();

  // Anything that shouldn't be listening closes before the rules change: a device
  // losing its last remote host, or one of ours with no record behind it (a mid-way
  // failure, an unreadable networks.json). Taking the rules away first would leave it
  // open to anyone for a moment. One that won't close keeps a DROP for its ID.
  const links = await readVxlanLinks();
  const stuckOpen: VxlanTunnel[] = [];
  for (const link of links) {
    if (!link.up || !OUR_DEVICE.test(link.name)) continue;
    const record = vxlans.find((n) => vxlanDeviceName(n.vni) === link.name);
    if (record && record.peers.length > 0) continue;
    if ((await runSafe('ip', ['link', 'set', link.name, 'down'])) !== null) link.up = false;
    else stuckOpen.push({ vni: link.vni, port: link.port, peers: [], stuckOpen: true });
  }

  const firewallProblem = await syncFirewall([...vxlans.map(tunnelOf), ...stuckOpen]);
  if (vxlans.length === 0) return problems;

  for (const n of vxlans) {
    const mine: string[] = [];
    let bridgeUp = await bridgeExists(n.bridge);
    if (!bridgeUp) {
      // Stopped by hand, or autostart failed at boot.
      mine.push(...await restoreBridge(n.libvirtName, n.bridge));
      bridgeUp = await bridgeExists(n.bridge);
    }
    if (bridgeUp) mine.push(...await reconnectIfRebuilt(n.bridge));

    const device = vxlanDeviceName(n.vni);
    const have = links.find((l) => l.name === device);
    const havePeers = have ? (await readFdb(device)).floodPeers : [];
    const plan = planTunnel(
      { ...tunnelOf(n), mtu: n.mtu, bridge: bridgeUp ? n.bridge : null, allowUp: firewallProblem === null },
      have,
      havePeers,
    );
    if (plan.conflict) mine.push(plan.conflict);
    for (const step of plan.steps) {
      try {
        await run(step.tool, step.args);
      } catch (err) {
        const why = plainError(err);
        mine.push(/Unknown device type/i.test(why)
          ? `This host's kernel has no VXLAN support: the vxlan module is missing (modprobe vxlan).`
          : `${step.tool} ${step.args.join(' ')}: ${why}`);
        break;
      }
    }
    if (firewallProblem && n.peers.length > 0) mine.push(firewallProblem);

    if (mine.length > 0) {
      problems.set(n.id, mine);
      lastProblems.set(n.id, mine);
    }
  }
  return problems;
}

export async function removeVxlanDevice(vni: number): Promise<void> {
  await runSafe('ip', ['link', 'delete', vxlanDeviceName(vni)]);
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface VxlanPeerStatus {
  address: string;
  /** Machines learned behind this host. More than zero means frames have arrived from it. */
  machines: number;
}

export interface VxlanRuntime {
  /** 'local': no remote hosts, so its device is down on purpose. */
  tunnel: 'local' | 'up' | 'down';
  /** The libvirt network, and so the bridge, is running. */
  bridgeUp: boolean;
  rxBytes: number;
  txBytes: number;
  peers: VxlanPeerStatus[];
  /** What other hosts have to list to reach this one. */
  localAddress: string | null;
  problems: string[];
}

export async function readVxlanRuntime(networks: readonly Network[]): Promise<Map<string, VxlanRuntime>> {
  const vxlans = networks.filter(isVxlan);
  const out = new Map<string, VxlanRuntime>();
  if (vxlans.length === 0) return out;
  const links = await readVxlanLinks();
  const defaultSource = await sourceAddressTowards('1.1.1.1');
  for (const n of vxlans) {
    const device = vxlanDeviceName(n.vni);
    const link = links.find((l) => l.name === device);
    const fdb = link ? await readFdb(device) : parseFdb('[]');
    out.set(n.id, {
      tunnel: n.peers.length === 0 ? 'local' : link?.up ? 'up' : 'down',
      bridgeUp: await bridgeExists(n.bridge),
      rxBytes: link?.rxBytes ?? 0,
      txBytes: link?.txBytes ?? 0,
      peers: n.peers.map((address) => ({ address, machines: fdb.learned.get(address) ?? 0 })),
      localAddress: (n.peers[0] ? await sourceAddressTowards(n.peers[0]) : null) ?? defaultSource,
      problems: lastProblems.get(n.id) ?? [],
    });
  }
  return out;
}
