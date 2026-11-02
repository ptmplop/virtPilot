// Keeps a VM's firewall on what the VM has now. Apply says what the rules are and that they should
// be in force. From then on nobody should have to press it again: not after a host restart, nor
// because a guest got a new address, nor because a NIC came or went.
//
// The rules are in force at a VM's taps whatever addresses it uses (see lib/bridgeFilter). These
// passes look after the other half, FORWARD's, which goes by address: only it sees the real client of
// a forward the host translated, and its allow rules can let in what libvirt refuses. Three rules
// hold it up. An address comes off only on evidence that it isn't this VM's any more, and never
// while a port forward names it: a forward's ACCEPT sits under these jumps, so taking one away opens
// that forward to the world. What a guest can say for itself is no evidence: any guest can answer
// ARP for any address or change its MAC, and that mustn't take its own rules off, or a neighbour's.
// And what a guest says is used only for a NIC nothing better speaks for, never for an address
// another VM has a claim on: its chain would sit above that VM's.

import { addFirewallAddress, firewallAddresses, firewallChainsExist, firewallInForce, jumpsOutOfPlace, keepInForce, listFirewallFiles, noteRulesAlreadyInForce, raiseFirewallAddresses, removeFirewallAddress, removeVmFirewall, sweepBridgeFilter, syncBridgePorts, type FirewallFile } from './firewallService.js';
import * as logService from './logService.js';
import { ipInCidr, listNetworks, type Network } from './networkService.js';
import { listPortForwards } from './portForwardService.js';
import { runSafe, virsh, virshBatch } from './safeExec.js';
import { findVm, getVmNics, listNicsOf, listVmsWithNics, parseStatus } from './vmService.js';
import { getVmMeta, listVmMetas, type VmMeta } from './vmMetaService.js';
import { parseDhcpLeases, parseDomIfAddr, parseNeighbours, type NicAddress } from '../lib/vmAddresses.js';
import { validateBridgeName } from '../lib/validate.js';
import type { VmNic, VmStatus } from '../types.js';

/** What a pass has read of the host, each asked once however many VMs want it. */
interface Readings {
  networks: Network[];
  leases: (network: Network) => Promise<Map<string, string>>;
  neighbours: (bridge: string) => Promise<NicAddress[]>;
  metas: Promise<VmMeta[]>;
  /** Every other VM's NICs by MAC. A whole roster, so only asked for when an address might come off. */
  macOwners: () => Promise<Map<string, string>>;
  /** FORWARD as iptables lists it. */
  forward: Promise<string>;
  forwards: Promise<Array<{ vmUuid: string; vmIp: string }>>;
}

function freshReadings(networks: Network[]): Readings {
  const once = <T>(read: (key: string) => Promise<T>) => {
    const seen = new Map<string, Promise<T>>();
    return (key: string) => {
      if (!seen.has(key)) seen.set(key, read(key));
      return seen.get(key)!;
    };
  };
  const leases = once(async (libvirtName) => parseDhcpLeases(await virsh(['net-dhcp-leases', libvirtName]).catch(() => '')));
  const owners = once(async () => new Map((await listVmsWithNics(networks)).flatMap((vm) => vm.nics.map((n) => [n.mac.toLowerCase(), vm.id] as const))));
  return {
    networks,
    leases: (network) => (network.libvirtName ? leases(network.libvirtName) : Promise.resolve(new Map())),
    neighbours: once(async (bridge) => {
      // A NIC's source needn't be a bridge: `default` on a network VirtPilot has no record of, or `-` on one unplugged.
      let name: string;
      try {
        name = validateBridgeName(bridge);
      } catch {
        return [];
      }
      return parseNeighbours(await runSafe('ip', ['-4', 'neigh', 'show', 'dev', name], { timeout: 5_000 }) ?? '', { stale: true });
    }),
    metas: listVmMetas().catch(() => []),
    macOwners: () => owners(''),
    forward: runSafe('iptables', ['-w', '5', '-S', 'FORWARD']).then((dump) => dump ?? ''),
    forwards: listPortForwards().catch(() => []),
  };
}

// Filtered only across the bridge. Nothing is routed to it, and a jump in FORWARD for its address
// sits above libvirt's isolation of the network and lets other networks in.
function isVxlanNic(nic: VmNic, networks: readonly Network[]): boolean {
  return networks.some((n) => n.type === 'vxlan' && n.bridge === nic.source);
}

function networkOf(nic: VmNic, networks: readonly Network[]): Network | undefined {
  return networks.find((n) => n.bridge === nic.source);
}

/** A row in a lease table on this VM's networks for this address, and whose MAC. */
async function leaseHolder(ip: string, nics: readonly VmNic[], readings: Readings): Promise<string | undefined> {
  for (const nic of nics) {
    const network = networkOf(nic, readings.networks);
    if (!network?.cidr || !ipInCidr(ip, network.cidr)) continue;
    for (const [mac, leased] of await readings.leases(network)) {
      if (leased === ip) return mac;
    }
  }
  return undefined;
}

async function fixedForAnother(ip: string, vmId: string, readings: Readings): Promise<boolean> {
  return (await readings.metas).some((m) => m.uuid !== vmId.toLowerCase() && m.networks?.some((n) => n.ip === ip));
}

/**
 * Whether another VM has a claim on an address, so that this one's chain has no business on it: a
 * lease or a fixed address, or a jump of its own that one of those or a forward backs. A jump on
 * nothing but a guest's word doesn't count, or one guest answering ARP first would keep a
 * neighbour's own firewall off its own address.
 */
async function claimedElsewhere(ip: string, vmId: string, nics: readonly VmNic[], readings: Readings): Promise<boolean> {
  const holder = await leaseHolder(ip, nics, readings);
  if (holder && !nics.some((n) => n.mac.toLowerCase() === holder)) return true;
  if (await fixedForAnother(ip, vmId, readings)) return true;
  const short = vmId.replace(/-/g, '').slice(0, 8);
  const other = (await readings.forward).split('\n').map((line) => line.match(new RegExp(`-d ${ip.replace(/\./g, '\\.')}/32 -j VP-IN-([0-9a-f]{8})$`))?.[1]).find((s) => s && s !== short);
  if (!other) return false;
  return (await readings.forwards).some((f) => f.vmIp === ip && f.vmUuid.replace(/-/g, '').startsWith(other));
}

/**
 * Whether an address is provably another VM's: the network leased it to a NIC of another VM on this
 * host, or it is fixed for one. A MAC no VM here has says nothing, as a guest can make one up.
 */
async function provedAnothers(ip: string, vmId: string, nics: readonly VmNic[], readings: Readings): Promise<boolean> {
  const holder = await leaseHolder(ip, nics, readings);
  if (holder) {
    const owner = (await readings.macOwners()).get(holder);
    if (owner && owner !== vmId) return true;
  }
  return fixedForAnother(ip, vmId, readings);
}

/**
 * The addresses of the NICs a firewall should be on. Rules Apply put on before every NIC was covered
 * stay on the one they were for, until someone presses it again: see `everyNic`. A stopped VM has
 * only what is fixed for it, as a lease outlives it by its whole lease time. Neighbours and agents
 * are the guest's word, which is good for adding to its own firewall and no more.
 */
async function addressesOf(vm: { id: string; status: VmStatus }, nics: readonly VmNic[], readings: Readings, everyNic: boolean): Promise<string[]> {
  const fixed = (await readings.metas).find((m) => m.uuid === vm.id.toLowerCase())?.networks ?? [];
  const live = nics.filter((n) => n.onlyIn !== 'saved' && !isVxlanNic(n, readings.networks));
  const primaryMac = fixed.find((a) => a.isPrimary)?.mac.toLowerCase();
  const first = live.find((n) => n.mac.toLowerCase() === primaryMac) ?? live[0];
  const routed = everyNic ? live : live.filter((n) => n === first);
  const found = new Set<string>();
  const unknown: VmNic[] = [];
  const onNetwork = (ip: string, nic: VmNic) => {
    const cidr = networkOf(nic, readings.networks)?.cidr;
    return !cidr || ipInCidr(ip, cidr);
  };
  for (const nic of routed) {
    const mac = nic.mac.toLowerCase();
    const candidates: string[] = [];
    const own = fixed.find((a) => a.mac.toLowerCase() === mac)?.ip;
    if (own) candidates.push(own);
    if (vm.status !== 'stopped') {
      const network = networkOf(nic, readings.networks);
      const lease = network ? (await readings.leases(network)).get(mac) : undefined;
      if (lease) candidates.push(lease);
      // A guest's word, only where nothing better speaks: one that set its own address.
      if (!own && !lease) {
        for (const n of await readings.neighbours(nic.source)) {
          if (n.mac === mac) candidates.push(n.ip);
        }
      }
    }
    const here = candidates.filter((ip) => onNetwork(ip, nic));
    for (const ip of here) found.add(ip);
    if (here.length === 0 && vm.status !== 'stopped') unknown.push(nic);
  }
  // Only for a NIC nothing else knows, such as one on a libvirt network VirtPilot has no record of.
  // The agent last and with a short limit: it can stall, and this costs that NIC a pass and nobody else.
  if (unknown.length > 0) {
    const answers = await virshBatch([['domifaddr', vm.id, '--source', 'lease'], ['domifaddr', vm.id, '--source', 'arp'], ['domifaddr', vm.id, '--source', 'agent']], { timeout: 3_000 }).catch(() => [] as Array<string | null>);
    for (const answer of answers) {
      for (const { mac, ip } of parseDomIfAddr(answer ?? '')) {
        const nic = unknown.find((n) => n.mac.toLowerCase() === mac);
        if (nic && onNetwork(ip, nic)) found.add(ip);
      }
    }
  }
  const usable: string[] = [];
  for (const ip of found) {
    if (!(await claimedElsewhere(ip, vm.id, nics, readings))) usable.push(ip);
  }
  return usable;
}

/** A running NIC's tap. A macvtap isn't a port of anything, and only a stopped VM's has no name. */
function tapsOf(nics: readonly VmNic[]): string[] {
  return nics.flatMap((n) => (n.onlyIn !== 'saved' && n.type !== 'direct' && n.target && /^[A-Za-z0-9]/.test(n.target) ? [n.target] : []));
}

/** What Apply needs: the addresses to put the firewall on, and the taps. */
export async function firewallPlan(uuid: string): Promise<{ addresses: string[]; ports: string[] }> {
  const [nics, networks] = await Promise.all([getVmNics(uuid), listNetworks()]);
  // If this fails the VM counts as running, which only means asking for more.
  const state = parseStatus(await virsh(['domstate', uuid]).catch(() => 'running'));
  return {
    addresses: await addressesOf({ id: uuid, status: state }, nics, freshReadings(networks), true),
    ports: tapsOf(nics),
  };
}

/** Whether an address can't be on this VM: none of its routed NICs is on a network it belongs to, and all of their networks are known. */
function offItsNetworks(ip: string, nics: readonly VmNic[], networks: readonly Network[]): boolean {
  const cidrs = nics.filter((n) => !isVxlanNic(n, networks)).map((n) => networkOf(n, networks)?.cidr);
  return cidrs.every(Boolean) && !cidrs.some((cidr) => ipInCidr(ip, cidr!));
}

function logChange(type: 'vm.firewall.restore' | 'vm.firewall.sync', vmUuid: string, subject: string, output: string, status: 'success' | 'error' = 'success'): void {
  void logService.appendLog({ type, subject, subjectUuid: vmUuid, status, output });
}

/**
 * First thing at every start, before a port forward's ACCEPT goes in with nothing above it. Asks
 * only the files and iptables, as libvirt can take minutes at boot: the addresses it had are right
 * unless something changed while the host was down, and the pass below sees to that.
 */
export async function restoreFirewalls(): Promise<void> {
  const forwards = await listPortForwards();
  for (const { vmUuid } of await listFirewallFiles()) {
    try {
      if (await firewallChainsExist(vmUuid)) await noteRulesAlreadyInForce(vmUuid);
      const ips = forwards.filter((f) => f.vmUuid === vmUuid).map((f) => f.vmIp);
      if ((await keepInForce(vmUuid, ips)) === 'rebuilt') {
        const name = (await getVmMeta(vmUuid).catch(() => null))?.name ?? vmUuid;
        logChange('vm.firewall.restore', vmUuid, name, `Rules put back after a restart, on ${(await firewallAddresses(vmUuid))?.join(', ') || 'no address yet'}.`);
      }
    } catch (err) {
      console.warn(`[firewall] Could not put back the rules of ${vmUuid}:`, err);
      logChange('vm.firewall.restore', vmUuid, vmUuid, `Could not put the rules back: ${String(err)}`, 'error');
    }
  }
}

async function syncOne(vmUuid: string, file: FirewallFile, vm: Awaited<ReturnType<typeof listNicsOf>>[number] | undefined, readings: Readings): Promise<void> {
  const forwards = await listPortForwards();
  const forwarded = forwards.filter((f) => f.vmUuid === vmUuid).map((f) => f.vmIp);
  if (!vm) {
    // Its address may pass to a VM these rules aren't for. The file stays, as a VM being restored
    // or redefined gets its firewall back with it. The bulk list saying so isn't enough, and nor
    // is the VM being gone with a forward's ACCEPT still sitting under these jumps.
    if ((await findVm(vmUuid).catch(() => undefined)) !== null || forwarded.length > 0) return;
    if (await firewallChainsExist(vmUuid)) {
      await removeVmFirewall(vmUuid);
      logChange('vm.firewall.sync', vmUuid, vmUuid, 'Rules taken out of force: libvirt has no such VM any more.');
    }
    return;
  }
  const wanted = await addressesOf(vm, vm.nics, readings, !!file.everyNic);
  const kept = await keepInForce(vmUuid, [...wanted, ...forwarded]);
  if (kept === 'none') return;
  if (kept === 'rebuilt') logChange('vm.firewall.restore', vmUuid, vm.name, `Rules put back, as something had changed them. On ${(await firewallAddresses(vmUuid))?.join(', ') || 'no address yet'}.`);
  await syncBridgePorts(vmUuid, tapsOf(vm.nics));
  const held = await firewallAddresses(vmUuid);
  if (!held) return;
  const said: string[] = [];
  for (const ip of [...wanted, ...forwarded]) {
    if (held.includes(ip)) continue;
    await addFirewallAddress(vmUuid, ip);
    said.push(`now also on ${ip}`);
  }
  for (const ip of held) {
    if (wanted.includes(ip) || forwarded.includes(ip)) continue;
    if (!offItsNetworks(ip, vm.nics, readings.networks) && !(await provedAnothers(ip, vmUuid, vm.nics, readings))) continue;
    // As they are now: a forward could have been made since this pass began.
    if ((await listPortForwards()).some((f) => f.vmUuid === vmUuid && f.vmIp === ip)) continue;
    await removeFirewallAddress(vmUuid, ip);
    said.push(`no longer on ${ip}, which isn't this VM's now`);
  }
  const low = jumpsOutOfPlace(await readings.forward, vmUuid);
  if (low.length > 0) {
    await raiseFirewallAddresses(vmUuid, low);
    said.push(`back above other rules on ${low.join(', ')}`);
  }
  if (said.length > 0) logChange('vm.firewall.sync', vmUuid, vm.name, `Firewall ${said.join('; ')}.`);
}

async function syncOnce(only?: string): Promise<void> {
  const every = await listFirewallFiles();
  const files = every.filter(({ vmUuid, file }) => firewallInForce(file) && (!only || vmUuid === only));
  if (!only) await sweepBridgeFilter().catch(() => {});
  if (files.length === 0) return;
  const networks = await listNetworks();
  const vms = await listNicsOf(files.map((f) => f.vmUuid), networks);
  const readings = freshReadings(networks);
  for (const { vmUuid, file } of files) {
    try {
      await syncOne(vmUuid, file, vms.find((v) => v.id === vmUuid), readings);
    } catch (err) {
      console.warn(`[firewall] Could not check the rules of ${vmUuid}:`, err);
    }
  }
}

// One at a time, around slow libvirt calls.
let passes: Promise<unknown> = Promise.resolve();
function queued(only?: string): Promise<void> {
  const next = passes.then(() => syncOnce(only));
  passes = next.catch((err) => console.warn('[firewall] Check failed:', err));
  return next;
}

/** For whoever just changed something about this VM, to save it waiting for the next pass. Never fails what it was called from. */
export function syncFirewall(vmUuid: string): void {
  void queued(vmUuid).catch(() => {});
}

export function startFirewallSync(intervalMs = 15_000): void {
  let waiting = false;
  const pass = () => {
    if (waiting) return;
    waiting = true;
    void queued().catch(() => {}).finally(() => { waiting = false; });
  };
  pass();
  setInterval(pass, intervalMs).unref();
}
