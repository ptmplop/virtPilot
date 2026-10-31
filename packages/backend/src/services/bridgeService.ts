// The host side of a managed bridge: its libvirt network and the physical NIC on it. The
// bridge comes back at boot by itself; a NIC doesn't, and it goes back on from here, once
// the host's own network configuration has had its turn: a NIC that has since become the
// way to reach this host is left alone. Runs under the service's own CAP_NET_ADMIN. While
// everything is in place a pass reads sysfs and runs one `ip` per NIC, and leaves libvirt
// alone so it can idle out. Decisions are in lib/managedBridge.ts; networkService owns the
// records and calls in here with them.

import fs from 'fs/promises';
import path from 'path';
import {
  holdForHostConfig,
  isManagedBridgeName,
  managedBridgeXml,
  parseDefaultRouteDevices,
  parseNetworkdState,
  planUplink,
  type UplinkFacts,
} from '../lib/managedBridge.js';
import { validateNicName } from '../lib/validate.js';
import { bridgeExists, defineLibvirtNetwork, plainError, reconnectIfRebuilt, restoreBridge } from './libvirtBridge.js';
import { run, virsh } from './safeExec.js';
import type { Network } from './networkService.js';

export function isManagedBridge(n: Network): boolean {
  return n.type === 'bridge' && typeof n.id === 'string' && isManagedBridgeName(n.bridge);
}

export function libvirtNameFor(id: string): string {
  return `virtpilot-${id.slice(0, 8)}`;
}

/** Every device the host's default routes go through, in both families. */
export async function defaultRouteDevices(): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    run('ip', ['-j', 'route', 'show', 'default']),
    run('ip', ['-6', '-j', 'route', 'show', 'default']),
  ]);
  return [...new Set([...parseDefaultRouteDevices(v4), ...parseDefaultRouteDevices(v6)])];
}

export async function hasGlobalAddress(nic: string): Promise<boolean> {
  return /\binet6? /.test(await run('ip', ['addr', 'show', 'dev', nic, 'scope', 'global']));
}

export async function nicMaster(nic: string): Promise<string | null> {
  return fs.readlink(`/sys/class/net/${nic}/master`).then((p) => path.basename(p), () => null);
}

async function isUp(nic: string): Promise<boolean> {
  const flags = await fs.readFile(`/sys/class/net/${nic}/flags`, 'utf8').catch(() => '0');
  return (parseInt(flags, 16) & 1) === 1;
}

async function networkdState(nic: string): Promise<UplinkFacts['networkd']> {
  const ifindex = await fs.readFile(`/sys/class/net/${nic}/ifindex`, 'utf8').catch(() => '');
  return parseNetworkdState(await fs.readFile(`/run/systemd/netif/links/${ifindex.trim()}`, 'utf8').catch(() => ''));
}

/** Throws if it can't say whether the host depends on this NIC, and the callers refuse rather than guess. */
export async function readUplinkFacts(nic: string): Promise<UplinkFacts> {
  if (!(await fs.access(`/sys/class/net/${nic}`).then(() => true, () => false))) {
    return { exists: false, master: null, up: false, hasAddress: false, defaultRoute: false, networkd: 'none' };
  }
  const [master, up] = await Promise.all([nicMaster(nic), isUp(nic)]);
  // Asked even of a port: an address that lands on one is the host wanting the NIC back.
  if (master) return { exists: true, master, up, hasAddress: await hasGlobalAddress(nic).catch(() => false), defaultRoute: false, networkd: 'none' };
  const [hasAddress, routes, networkd] = await Promise.all([hasGlobalAddress(nic), defaultRouteDevices(), networkdState(nic)]);
  return { exists: true, master, up, hasAddress, defaultRoute: routes.includes(nic), networkd };
}

/** Whether anything else sits on this NIC, such as a VLAN the host may be reached through. */
export async function hasUpperDevice(nic: string): Promise<boolean> {
  const names = await fs.readdir(`/sys/class/net/${nic}`).catch(() => [] as string[]);
  return names.some((name) => name.startsWith('upper_'));
}

const configuringSince = new Map<string, number>();

/** What went wrong, and whether the host has been seen using the NIC, if that has changed. */
async function syncUplink(n: Network): Promise<{ said: string[]; claimed?: boolean }> {
  if (!n.physicalNic) return { said: [] };
  const cutOff = `It stays off ${n.bridge}, so VMs on this network can only reach each other.`;
  let nic: string;
  let facts: UplinkFacts;
  try {
    nic = validateNicName(n.physicalNic);
    facts = await readUplinkFacts(nic);
  } catch (err) {
    return { said: [`Could not tell whether this host depends on ${n.physicalNic}: ${plainError(err)} ${cutOff}`] };
  }
  const { refusal, steps, claimed } = planUplink(nic, n.bridge, facts, { claimed: n.nicClaimed });
  const said = refusal ? [`${refusal} ${cutOff}`] : [];
  if (refusal) {
    configuringSince.delete(nic);
  } else if (facts.master !== n.bridge && facts.networkd === 'configuring') {
    const since = configuringSince.get(nic) ?? Date.now();
    configuringSince.set(nic, since);
    if (holdForHostConfig(since, Date.now())) {
      return { said: [`systemd-networkd is still configuring ${nic}, in case it is getting an address, so it stays off ${n.bridge} for up to two and a half minutes. To skip the wait, take it out of netplan.`], claimed };
    }
  } else {
    configuringSince.delete(nic);
  }
  for (const args of steps) {
    try {
      await run('ip', args);
    } catch (err) {
      return { said: [...said, `ip ${args.join(' ')}: ${plainError(err)}`], claimed };
    }
  }
  if (steps.length > 0 && !refusal) console.log(`[bridge] ${n.name}: ${nic} is up on ${n.bridge}`);
  return { said, claimed };
}

/** Asks first, as defining a name that exists fails. The definition is what brings the bridge back at the next boot. */
async function ensureDefinition(n: Network, libvirtName: string): Promise<string[]> {
  const wontComeBack = "Its bridge won't come back at the next boot:";
  try {
    const info = await virsh(['net-info', libvirtName]);
    if (!/^Autostart:\s+yes/im.test(info)) await virsh(['net-autostart', libvirtName]);
    return [];
  } catch (err) {
    if (!/no network with matching name/i.test(plainError(err))) return [`${wontComeBack} ${plainError(err)}`];
  }
  try {
    await defineLibvirtNetwork(libvirtName, managedBridgeXml({ libvirtName, bridge: n.bridge }), { start: false });
    return [];
  } catch (err) {
    return [`${wontComeBack} its libvirt network could not be defined: ${plainError(err)}`];
  }
}

const lastProblems = new Map<string, string[]>();
// Definitions seen in place since the service started. Asked of libvirt once each, and until
// the answer is good: after that a pass leaves libvirt alone, unless a bridge has gone.
const confirmed = new Set<string>();

/**
 * Make the host match the records. Safe at any time. Returns the records, changed if there is
 * anything to save, and what went wrong, by network.
 *
 * A bridge from before 2.16.3 gets its libvirt network here. One that is still live isn't
 * rebuilt, with VMs on it: replacing it now would gain nothing and blip their traffic.
 * Autostart only fires at boot, when the plain bridge is gone, and from then on libvirt owns
 * it. Its NIC is seen to at once, like any other: a NIC left down by the old code comes up here.
 */
export async function syncManagedBridges(networks: Network[]): Promise<{ networks: Network[]; problems: Map<string, string[]> }> {
  const problems = new Map<string, string[]>();
  const note = (id: string, said: string[]) => {
    if (said.length > 0) problems.set(id, [...(problems.get(id) ?? []), ...said]);
  };
  const changed = new Map<string, Network>();
  const current = (n: Network) => changed.get(n.id) ?? n;
  const uplink = async (n: Network) => {
    const { said, claimed } = await syncUplink(current(n));
    note(n.id, said);
    if (claimed !== undefined && claimed !== !!current(n).nicClaimed) changed.set(n.id, { ...current(n), nicClaimed: claimed || undefined });
  };
  const managed = networks.filter(isManagedBridge);

  // NICs on the bridges that are here come first. At boot VMs are starting now and want
  // their way out, and this needs nothing from libvirt, which may still be busy with them.
  const absent = new Set<string>();
  for (const n of managed) {
    if (await bridgeExists(n.bridge)) await uplink(n);
    else absent.add(n.id);
  }

  for (const n of managed) {
    const libvirtName = n.libvirtName ?? libvirtNameFor(n.id);
    if (!confirmed.has(libvirtName) || absent.has(n.id)) {
      const said = await ensureDefinition(n, libvirtName);
      note(n.id, said);
      if (said.length > 0) continue;
      confirmed.add(libvirtName);
      if (!n.libvirtName) changed.set(n.id, { ...current(n), libvirtName });
    }
    if (absent.has(n.id)) {
      note(n.id, await restoreBridge(libvirtName, n.bridge));
      if (await bridgeExists(n.bridge)) await uplink(n);
    }
    note(n.id, await reconnectIfRebuilt(n.bridge));
  }

  lastProblems.clear();
  for (const [id, said] of problems) lastProblems.set(id, said);
  return { networks: changed.size > 0 ? networks.map(current) : networks, problems };
}

export interface BridgeRuntime {
  bridgeUp: boolean;
  uplink: {
    nic: string;
    attached: boolean;
    up: boolean;
    /** Null when the kernel can't say, as for a link that is down. */
    carrier: boolean | null;
  } | null;
  problems: string[];
}

/** Sysfs alone: this is read every few seconds while the Networks page is open. */
export async function readBridgeRuntime(networks: readonly Network[]): Promise<Map<string, BridgeRuntime>> {
  const out = new Map<string, BridgeRuntime>();
  for (const n of networks.filter(isManagedBridge)) {
    let uplink: BridgeRuntime['uplink'] = null;
    if (typeof n.physicalNic === 'string') {
      // Goes into a path below, and a record can be edited by hand.
      const nic = path.basename(n.physicalNic);
      const carrier = await fs.readFile(`/sys/class/net/${nic}/carrier`, 'utf8').then((s) => s.trim() === '1', () => null);
      uplink = { nic, attached: (await nicMaster(nic)) === n.bridge, up: await isUp(nic), carrier };
    }
    out.set(n.id, { bridgeUp: await bridgeExists(n.bridge), uplink, problems: lastProblems.get(n.id) ?? [] });
  }
  return out;
}
