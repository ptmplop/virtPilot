// What decides a managed bridge: one VirtPilot creates (`vp<N>`), with a physical NIC on it
// if the operator named one. Nothing here touches the host; services/bridgeService.ts does.

import { escapeXml } from './validate.js';

/**
 * Only `vp<N>` is ours. Records migrated from the old "public" type can name an OS bridge,
 * and libvirt must never be told to create that: at boot it could get there before the
 * host's own network configuration.
 */
export function isManagedBridgeName(bridge: string): boolean {
  return /^vp\d+$/.test(bridge);
}

/**
 * The libvirt network that owns the bridge, which is what brings it back at boot before
 * any VM needs it. No <forward> and no <ip>: no DHCP or DNS from libvirt, no address for
 * the host, and traffic crosses it at layer 2 only. STP stays off, as it is on a bridge
 * made by hand: a port sending BPDUs can get a provider's switch port shut down.
 */
export function managedBridgeXml(opts: { libvirtName: string; bridge: string }): string {
  return `<network>
  <name>${escapeXml(opts.libvirtName)}</name>
  <bridge name='${escapeXml(opts.bridge)}' stp='off' delay='0'/>
</network>`;
}

export interface UplinkFacts {
  exists: boolean;
  /** The device it is a port of, if any. */
  master: string | null;
  /** Administratively up. A NIC nothing else configures comes up down after every boot. */
  up: boolean;
  /** A global address, in either family. */
  hasAddress: boolean;
  /** The host's default route, in either family, goes through it. */
  defaultRoute: boolean;
  /** What systemd-networkd is doing with it: 'none' if it leaves it alone, or isn't running. */
  networkd: 'none' | 'configuring' | 'finished';
}

/** Why this NIC must not go on this bridge, or null if it may. One already on it stays, unless it has an address. */
export function uplinkRefusal(nic: string, bridge: string, facts: UplinkFacts, opts: { claimed?: boolean } = {}): string | null {
  if (!facts.exists) return `${nic} is not on this host.`;
  if (facts.master && facts.master !== bridge) return `${nic} is part of ${facts.master}.`;
  if (facts.hasAddress) return `${nic} has an IP address: taking it for a bridge could cut this host off.`;
  if (facts.master === bridge) return null;
  if (facts.defaultRoute) return `${nic} carries this host's default route: taking it for a bridge would cut this host off.`;
  if (opts.claimed && facts.networkd !== 'none') return `This host's network configuration has given ${nic} an address, and still manages it: taking it could cut this host off. To use it for VMs, take it out of netplan.`;
  return null;
}

export interface UplinkPlan {
  refusal: string | null;
  /** Arguments to `ip`, in order. */
  steps: string[][];
  /** Whether the host has been seen using this NIC, to remember. Undefined: nothing new. */
  claimed?: boolean;
}

/**
 * A claim is what stops a NIC being taken in a moment when the host has lost its address but
 * still means to use it: a cable pulled, a DHCP server down, networkd restarting. Once the
 * NIC is a port, DHCP can't finish and an address is no use. networkd letting go of it is
 * the one thing that ends a claim: nothing else says the host has finished with it.
 */
export function planUplink(nic: string, bridge: string, facts: UplinkFacts, opts: { claimed?: boolean } = {}): UplinkPlan {
  const refusal = uplinkRefusal(nic, bridge, facts, opts);
  if (refusal) {
    // A port that has been given an address can't use it: let the host have it.
    const steps = facts.master === bridge ? [['link', 'set', nic, 'nomaster']] : [];
    return { refusal, steps, claimed: facts.hasAddress || facts.defaultRoute || undefined };
  }
  const steps: string[][] = [];
  if (facts.master !== bridge) steps.push(['link', 'set', nic, 'master', bridge]);
  if (!facts.up) steps.push(['link', 'set', nic, 'up']);
  return { refusal: null, steps, claimed: opts.claimed ? false : undefined };
}

/**
 * How long a NIC stays off its bridge while systemd-networkd is still configuring it. An
 * address may be on its way, by DHCP behind a slow switch port, say, and once the NIC is a
 * port DHCP can never finish, so the host would lose it for good. From outside, `dhcp4: false`
 * on a network with no router advertisements looks the same and stays that way, so it can't
 * wait for ever. networkd's DHCP client backs off, asking at about 62 s and then 126 s, so
 * this has to see the second of those through.
 */
export const HOST_CONFIG_HOLD_MS = 150_000;

export function holdForHostConfig(since: number, now: number): boolean {
  return now - since < HOST_CONFIG_HOLD_MS;
}

/** From /run/systemd/netif/links/<ifindex>. A link networkd doesn't manage says `unmanaged`. */
export function parseNetworkdState(linkState: string): UplinkFacts['networkd'] {
  const state = linkState.match(/^ADMIN_STATE=(.+)$/m)?.[1];
  if (!state || state === 'unmanaged') return 'none';
  return ['pending', 'initialized', 'configuring'].includes(state) ? 'configuring' : 'finished';
}

/** The devices in the output of `ip -j route show default`, multipath routes included. */
export function parseDefaultRouteDevices(raw: string): string[] {
  const routes = JSON.parse(raw) as Array<{ dev?: string; nexthops?: Array<{ dev?: string }> }>;
  const devices = routes.flatMap((r) => [r.dev, ...(r.nexthops ?? []).map((h) => h.dev)]);
  return [...new Set(devices.filter((d): d is string => !!d))];
}
