import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getNetwork, ipInCidr, parseCidr, enumerateUsableIps, NetworkError } from './networkService.js';
import { addFirewallAddress, firewallAddresses, removeFirewallAddress, tokeniseIptablesRule, reassertForwardJumps } from './firewallService.js';
import * as logService from './logService.js';
import { run, runSafe, virsh } from './safeExec.js';
import { parseDhcpLeases } from '../lib/vmAddresses.js';
import {
  validateVmUuid,
  validateMac,
  validateIpv4,
  validateBridgeName,
  validateNicName,
  validatePort,
  validateProtocol,
} from '../lib/validate.js';

export interface PortForward {
  id: string;
  networkId: string;
  vmUuid: string;
  mac: string;
  vmIp: string;
  protocol: 'tcp' | 'udp';
  hostPort: number;
  vmPort: number;
  description?: string;
  createdAt: string;
  /**
   * Ingress match (`-i vpN` / `! -i vpN`) the DNAT rule was actually installed
   * with. Pinned at add time because `-C` and `-D` must reproduce the exact
   * same vector; re-deriving it later can yield a different — or empty — match.
   * Absent on records written by older builds.
   */
  ingressMatch?: string[];
}

export interface DhcpReservation {
  networkId: string;
  libvirtName: string;
  mac: string;
  ip: string;
  vmUuid: string;
  createdAt: string;
}

// A forward's record, its reservation and its rules change together, around slow libvirt calls.
// One at a time, or two overlapping lose a record, or bring back one just deleted.
let forwardChanges: Promise<unknown> = Promise.resolve();
function oneChangeAtATime<T>(change: () => Promise<T>): Promise<T> {
  const run = forwardChanges.then(change, change);
  forwardChanges = run.catch(() => {});
  return run;
}

const forwardsPath = () => path.join(config.storageRoot, 'port-forwards.json');
const reservationsPath = () => path.join(config.storageRoot, 'dhcp-reservations.json');

async function readForwards(): Promise<PortForward[]> {
  try {
    return JSON.parse(await fs.readFile(forwardsPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function writeForwards(forwards: PortForward[]): Promise<void> {
  await fs.writeFile(forwardsPath(), JSON.stringify(forwards, null, 2), 'utf8');
}

async function readReservations(): Promise<DhcpReservation[]> {
  try {
    return JSON.parse(await fs.readFile(reservationsPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function writeReservations(reservations: DhcpReservation[]): Promise<void> {
  await fs.writeFile(reservationsPath(), JSON.stringify(reservations, null, 2), 'utf8');
}

function ipToNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

// ARP first, then the network's own lease table, the same places the VM's Network tab
// reads: "Lock IP" has to pin the address it is showing, not pick another.
async function resolveCurrentVmIp(vmUuid: string, mac: string, libvirtName: string): Promise<string | null> {
  try {
    const stdout = await virsh(['domifaddr', validateVmUuid(vmUuid), '--source', 'arp']);
    for (const line of stdout.split('\n')) {
      if (line.toLowerCase().includes(mac.toLowerCase())) {
        const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (m) return m[1];
      }
    }
  } catch {}
  try {
    return parseDhcpLeases(await virsh(['net-dhcp-leases', libvirtName])).get(mac.toLowerCase()) ?? null;
  } catch {}
  return null;
}

async function virshNetUpdate(libvirtName: string, op: 'add' | 'delete', xml: string): Promise<void> {
  // libvirtName is generated server-side as `virtpilot-<uuid8>` but we still
  // restrict it to the libvirt-allowed character set.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(libvirtName)) throw new Error('Invalid libvirt network name');
  const tmpFile = path.join(os.tmpdir(), `virtpilot-host-${randomUUID()}.xml`);
  await fs.writeFile(tmpFile, xml, 'utf8');
  try {
    try {
      await virsh(['net-update', libvirtName, op, 'ip-dhcp-host', tmpFile, '--live', '--config']);
    } catch {
      await virsh(['net-update', libvirtName, op, 'ip-dhcp-host', tmpFile, '--config']);
    }
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// Returns the reserved IP plus whether *this* call created the reservation.
// Callers that roll back on failure must only release what they created: the
// operator may have pinned the IP themselves via "Lock IP", and that lease is
// not ours to throw away.
async function ensureReservation(
  networkId: string,
  vmUuid: string,
  macRaw: string
): Promise<{ ip: string; created: boolean }> {
  const mac = validateMac(macRaw);
  const network = await getNetwork(networkId);
  if (!network || network.type !== 'nat' || !network.libvirtName) {
    throw new NetworkError('Port forwards are only supported on NAT networks');
  }

  // Ahead of any reservation already held, which says only that a NIC was here once. A forward
  // for anything else would send traffic to an address that isn't this VM's.
  const nic = (await (await import('./vmService.js')).getVmNics(vmUuid)).find((n) => n.mac.toLowerCase() === mac && n.source === network.bridge);
  if (!nic) throw new NetworkError(`This VM has no NIC with MAC ${mac} on ${network.name}.`);
  // Gone at the VM's next start, leaving what was made for it with no row to remove it from.
  if (nic.onlyIn === 'live') throw new NetworkError("This NIC is only on the VM until its next start, so it can't have a port forward or a locked IP.", 409);

  const reservations = await readReservations();
  const existing = reservations.find((r) => r.networkId === networkId && r.mac === mac);
  if (existing) return { ip: existing.ip, created: false };

  const { first } = parseCidr(network.cidr);
  const firstNum = ipToNum(first);
  const dhcpStartNum = network.gateway === first ? firstNum + 1 : firstNum;

  // Another VM's lease isn't free. A NIC with no address of its own, such as a stopped VM's,
  // would be given it, and the forward would land on that VM.
  const leases = parseDhcpLeases(await virsh(['net-dhcp-leases', network.libvirtName]).catch(() => ''));
  const takenIps = new Set([
    network.gateway,
    ...reservations.filter((r) => r.networkId === networkId).map((r) => r.ip),
    ...[...leases].filter(([leasedTo]) => leasedTo !== mac).map(([, ip]) => ip),
  ]);

  const currentIp = await resolveCurrentVmIp(vmUuid, mac, network.libvirtName);
  // ARP knows a MAC whatever network it is on: a NIC moved here for its next start still has
  // an address on the last one.
  const available = (currentIp && ipInCidr(currentIp, network.cidr) && !takenIps.has(currentIp))
    ? currentIp
    : (() => {
        const usable = enumerateUsableIps(network.cidr);
        return usable.find((ip) => !takenIps.has(ip) && ipToNum(ip) >= dhcpStartNum) ?? null;
      })();

  if (!available) {
    throw new NetworkError('No free IP addresses available in this NAT network for a DHCP reservation', 409);
  }

  // Build the XML using only validated values — no string interpolation of raw
  // user input.
  const safeIp = validateIpv4(available);
  await virshNetUpdate(network.libvirtName, 'add', `<host mac='${mac}' ip='${safeIp}'/>`);

  const reservation: DhcpReservation = {
    networkId,
    libvirtName: network.libvirtName,
    mac,
    ip: available,
    vmUuid,
    createdAt: new Date().toISOString(),
  };
  await writeReservations([...reservations, reservation]);
  return { ip: available, created: true };
}

async function releaseReservationIfUnused(networkId: string, mac: string): Promise<void> {
  const forwards = await readForwards();
  if (forwards.some((f) => f.networkId === networkId && f.mac === mac)) return;

  const reservations = await readReservations();
  const reservation = reservations.find((r) => r.networkId === networkId && r.mac === mac);
  if (!reservation) return;

  try {
    await virshNetUpdate(reservation.libvirtName, 'delete', `<host mac='${mac}' ip='${reservation.ip}'/>`);
  } catch { /* already removed from libvirt */ }

  await writeReservations(
    reservations.filter((r) => !(r.networkId === networkId && r.mac === mac))
  );
}

// Looks up the friendly VM name for a given UUID. Used solely for human-readable
// error messages — never as an authentication or routing key.
async function lookupVmName(vmUuid: string): Promise<string> {
  // Lazy import to avoid a circular dependency between portForwardService and
  // vmMetaService at module load time.
  const meta = await (await import('./vmMetaService.js')).getVmMeta(vmUuid);
  return meta?.name ?? vmUuid;
}

// Every invocation waits up to 5s for the xtables lock — libvirt and the
// firewall service drive iptables on the same host.
const WAIT = ['-w', '5'];

// PREROUTING sees packets arriving on the vpN guest bridges as well as from
// the outside world, so a DNAT matched on --dport alone silently rewrites
// every other guest's outbound connections to that port. Pin the rule to the
// host's WAN interface, resolved once from the default route — the answer is
// cached because the -A, -C and -D argument vectors must stay identical.
let wanIface: Promise<string | null> | null = null;

function resolveWanIface(): Promise<string | null> {
  if (!wanIface) wanIface = (async () => {
    const out = await runSafe('ip', ['route', 'show', 'default']);
    const m = out?.match(/\bdev\s+(\S+)/);
    try {
      if (m) return validateNicName(m[1]);
    } catch { /* unusable interface name — fall through to the bridge exclusion */ }
    console.warn('[port-forward] Could not determine the WAN interface - falling back to excluding the guest bridge on DNAT rules');
    return null;
  })();
  return wanIface;
}

// Restricts a DNAT rule to traffic that did not originate on a guest bridge.
// Never returns an empty vector: falling through to [] used to produce a `-D`
// that omitted the ingress match, so it failed to match the live rule while the
// record was removed from port-forwards.json — orphaning the DNAT forever with
// nothing left able to find it. Better to fail the operation loudly.
async function resolveIngressMatch(fwd: PortForward): Promise<string[]> {
  const wan = await resolveWanIface();
  if (wan) return ['-i', wan];
  // Without a default route we can't name the WAN side, so settle for the
  // weaker guarantee: never match traffic coming from this forward's own
  // guest bridge.
  const network = await getNetwork(fwd.networkId);
  if (network?.bridge) return ['!', '-i', validateBridgeName(network.bridge)];
  throw new Error(
    `Cannot determine the ingress interface for port forward ${fwd.id}: the host has no default route and network ${fwd.networkId} is unknown. Refusing to build a DNAT rule that would not match the live one.`
  );
}

// The match this forward's rule was actually installed with, if the record
// carries one. Re-validated because it round-trips through JSON on disk.
function storedIngressMatch(fwd: PortForward): string[] | null {
  const stored = fwd.ingressMatch;
  if (!Array.isArray(stored) || stored.length === 0) return null;
  if (stored.length === 2 && stored[0] === '-i') return ['-i', validateNicName(stored[1])];
  if (stored.length === 3 && stored[0] === '!' && stored[1] === '-i') {
    return ['!', '-i', validateBridgeName(stored[2])];
  }
  throw new Error(`Port forward ${fwd.id} has an unrecognised stored ingress match`);
}

async function natRuleArgs(fwd: PortForward, op: '-A' | '-D' | '-C'): Promise<string[]> {
  // All values were validated when the forward was created and persisted, but
  // re-validate at every shell boundary so a tampered JSON file can't smuggle
  // shell metacharacters back in.
  const proto = validateProtocol(fwd.protocol);
  if (proto !== 'tcp' && proto !== 'udp') throw new Error('Only tcp/udp supported');
  const hostPort = validatePort(fwd.hostPort);
  const vmPort = validatePort(fwd.vmPort);
  const vmIp = validateIpv4(fwd.vmIp);
  if (!/^[A-Za-z0-9._-]+$/.test(fwd.id)) throw new Error('Invalid forward id');
  return [
    ...WAIT,
    '-t', 'nat',
    op, 'PREROUTING',
    // Prefer whatever was pinned when the rule went in — the -A, -C and -D
    // vectors have to stay byte-identical.
    ...(storedIngressMatch(fwd) ?? await resolveIngressMatch(fwd)),
    '-p', proto,
    '--dport', String(hostPort),
    '-j', 'DNAT',
    '--to-destination', `${vmIp}:${vmPort}`,
    '-m', 'comment', '--comment', `virtpilot-${fwd.id}`,
  ];
}

/**
 * The FORWARD ACCEPT that lets the DNAT'd packet actually reach the guest.
 *
 * Must be *inserted*, never appended. libvirt puts its own jumps at the top of
 * FORWARD, and the chain they lead to ends with
 * `-o <bridge> -j REJECT --reject-with icmp-port-unreachable`. An appended rule
 * sits below that, so the packet is rejected before it is ever consulted — the
 * DNAT rule counts hits, nothing reaches the guest, and the caller sees
 * "connection refused". Every port forward onto a managed NAT network was dead
 * on arrival because of it.
 */
function forwardRuleArgs(fwd: PortForward, op: '-I' | '-D' | '-C'): string[] {
  const proto = validateProtocol(fwd.protocol);
  if (proto !== 'tcp' && proto !== 'udp') throw new Error('Only tcp/udp supported');
  const vmPort = validatePort(fwd.vmPort);
  const vmIp = validateIpv4(fwd.vmIp);
  if (!/^[A-Za-z0-9._-]+$/.test(fwd.id)) throw new Error('Invalid forward id');
  return [
    ...WAIT,
    op, 'FORWARD',
    '-d', vmIp,
    '-p', proto,
    '--dport', String(vmPort),
    '-j', 'ACCEPT',
    '-m', 'comment', '--comment', `virtpilot-${fwd.id}`,
  ];
}

async function addIptablesRules(fwd: PortForward, firewallKeepOnly?: readonly string[]): Promise<void> {
  // Resolve the ingress match once and pin it to the record, so a later -C/-D
  // reproduces exactly the vector we are about to install even if the default
  // route or the network has changed underneath us in the meantime. Refreshed
  // on every add, which keeps the stored value honest: applyAllRules re-adds
  // every rule at startup, right after reconcileNatRules has cleared the table.
  fwd.ingressMatch = await resolveIngressMatch(fwd);

  const [natExists, fwdExists] = await Promise.all([
    runSafe('iptables', await natRuleArgs(fwd, '-C')).then((r) => r !== null),
    runSafe('iptables', forwardRuleArgs(fwd, '-C')).then((r) => r !== null),
  ]);
  if (!natExists) await run('iptables', await natRuleArgs(fwd, '-A'));
  if (!fwdExists) await run('iptables', forwardRuleArgs(fwd, '-I'));

  // Our ACCEPT went in at the head of FORWARD, which would place it above this
  // VM's firewall chain. The firewall is the policy — put its jumps back on
  // top so the outcome doesn't depend on the order the operator happened to
  // configure the two features in.
  await reassertForwardJumps(fwd.vmUuid, fwd.vmIp, firewallKeepOnly);
}

// Belt and braces: delete every PREROUTING rule still carrying this forward's
// comment tag, whatever vector it was installed with. A rule we can no longer
// reproduce exactly would otherwise stay live forever once its record is gone.
async function deleteTaggedNatRules(id: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid forward id');
  const dump = await runSafe('iptables', [...WAIT, '-t', 'nat', '-S', 'PREROUTING']);
  if (dump === null) return;
  const tag = `virtpilot-${id}`;
  for (const line of dump.split('\n')) {
    const tokens = tokeniseIptablesRule(line.trim());
    if (tokens[0] !== '-A' || tokens[1] !== 'PREROUTING') continue;
    const commentIdx = tokens.indexOf('--comment');
    if (commentIdx === -1 || tokens[commentIdx + 1] !== tag) continue;
    await runSafe('iptables', [...WAIT, '-t', 'nat', '-D', ...tokens.slice(1)]);
  }
}

async function removeIptablesRules(fwd: PortForward): Promise<void> {
  // Try the pinned vector first, then sweep by comment. Older records carry no
  // pinned match, and resolving one can now throw (no default route and no
  // network) — the sweep is what guarantees we never leave an orphan behind.
  try {
    await runSafe('iptables', await natRuleArgs(fwd, '-D'));
  } catch (err) {
    console.warn(`[port-forward] Could not rebuild the DNAT vector for ${fwd.id}; falling back to a comment sweep:`, err);
  }
  await deleteTaggedNatRules(fwd.id);
  await runSafe('iptables', forwardRuleArgs(fwd, '-D'));
}

export async function listPortForwards(networkId?: string): Promise<PortForward[]> {
  const forwards = await readForwards();
  return networkId ? forwards.filter((f) => f.networkId === networkId) : forwards;
}

export async function getPortForwardsForVm(vmUuid: string): Promise<PortForward[]> {
  const forwards = await readForwards();
  return forwards.filter((f) => f.vmUuid === vmUuid);
}

interface NewForward {
  networkId: string;
  vmUuid: string;
  mac: string;
  protocol: 'tcp' | 'udp';
  hostPort: number;
  vmPort: number;
  description?: string;
}

export function createPortForward(opts: NewForward): Promise<PortForward> {
  return oneChangeAtATime(() => createPortForwardNow(opts));
}

async function createPortForwardNow(opts: NewForward): Promise<PortForward> {
  const vmUuid = validateVmUuid(opts.vmUuid);
  const mac = validateMac(opts.mac);
  const protocol = validateProtocol(opts.protocol);
  if (protocol !== 'tcp' && protocol !== 'udp') throw new Error('Only tcp/udp supported');
  const hostPort = validatePort(opts.hostPort);
  const vmPort = validatePort(opts.vmPort);

  const forwards = await readForwards();
  const conflict = forwards.find((f) => f.hostPort === hostPort && f.protocol === protocol);
  if (conflict) {
    const conflictName = await lookupVmName(conflict.vmUuid);
    throw new NetworkError(`Host port ${hostPort}/${protocol} is already forwarded to VM "${conflictName}"`, 409);
  }

  const { ip: vmIp, created: reservationCreated } = await ensureReservation(opts.networkId, vmUuid, mac);

  const forward: PortForward = {
    id: randomUUID(),
    networkId: opts.networkId,
    vmUuid,
    mac,
    vmIp,
    protocol,
    hostPort,
    vmPort,
    description: opts.description,
    createdAt: new Date().toISOString(),
  };

  try {
    // A new reservation can give the NIC a new address, and if it is the NIC the firewall filters,
    // the firewall leaves the old one, which may pass to another VM. Other forwards' addresses
    // stay. Asked before any rule goes in, so nothing waits on libvirt with this forward's ACCEPT
    // above the firewall.
    const firewallNic = reservationCreated ? await (await import('./vmService.js')).firewallNicMac(vmUuid) : undefined;
    await addIptablesRules(forward, firewallNic === mac ? forwards.filter((f) => f.vmUuid === vmUuid).map((f) => f.vmIp) : undefined);
    await writeForwards([...forwards, forward]);
  } catch (err) {
    // The DNAT rule may already be live while the record never reached
    // port-forwards.json — nothing in the product could ever remove it again.
    // Undo the rules, and the reservation only if this call took it out: an
    // operator who pinned the IP with "Lock IP" beforehand must keep their
    // lease, and releaseReservationIfUnused only guards against other forwards.
    await removeIptablesRules(forward).catch(() => {});
    if (reservationCreated) {
      await releaseReservationIfUnused(forward.networkId, forward.mac).catch(() => {});
    }
    throw err;
  }
  return forward;
}

export function deletePortForward(id: string): Promise<void> {
  return oneChangeAtATime(async () => {
    const forwards = await readForwards();
    const forward = forwards.find((f) => f.id === id);
    if (!forward) throw new Error(`Port forward ${id} not found`);

    await removeIptablesRules(forward);
    await writeForwards(forwards.filter((f) => f.id !== id));
    await releaseFirewallAddress(forward);
    await releaseReservationIfUnused(forward.networkId, forward.mac);
  });
}

/**
 * With its forward gone, an address is free to pass to another VM, which would then be filtered
 * by this one's rules. Not the last address, nor that of the NIC the firewall is there for, and
 * if libvirt can't say which that is, it stays: a jump too many only filters this VM.
 */
async function releaseFirewallAddress(forward: PortForward): Promise<void> {
  const others = await readForwards();
  if (others.some((f) => f.vmUuid === forward.vmUuid && f.vmIp === forward.vmIp)) return;
  const held = await firewallAddresses(forward.vmUuid);
  if (!held || held.length < 2 || !held.includes(forward.vmIp)) return;
  const nic = await (await import('./vmService.js')).firewallNicMac(forward.vmUuid).catch(() => forward.mac);
  if (nic !== forward.mac) await removeFirewallAddress(forward.vmUuid, forward.vmIp);
}

async function deleteForwardsWhere(match: (f: PortForward) => boolean): Promise<void> {
  const forwards = await readForwards();
  const mine = forwards.filter(match);
  if (mine.length === 0) return;
  for (const fwd of mine) {
    await removeIptablesRules(fwd);
  }
  await writeForwards(forwards.filter((f) => !match(f)));
  for (const fwd of mine) {
    await releaseFirewallAddress(fwd);
    await releaseReservationIfUnused(fwd.networkId, fwd.mac);
  }
}

export function deletePortForwardsForVm(vmUuid: string): Promise<void> {
  return oneChangeAtATime(() => deleteForwardsWhere((f) => f.vmUuid === vmUuid));
}

/**
 * With a NIC gone, its forwards and any address locked for it have no use, and nothing left in
 * the dashboard to remove them by: their list is drawn per NIC. The DNAT rule would stay live,
 * the host port taken, and the network undeletable.
 */
export function deletePortForwardsForNic(vmUuid: string, macRaw: string): Promise<void> {
  const mac = validateMac(macRaw);
  return oneChangeAtATime(async () => {
    await deleteForwardsWhere((f) => f.vmUuid === vmUuid && f.mac.toLowerCase() === mac);
    for (const r of await readReservations()) {
      if (r.vmUuid === vmUuid && r.mac === mac) await releaseReservationIfUnused(r.networkId, r.mac);
    }
  });
}

/**
 * For a network about to go, with no VM left on it: whatever is left on it belongs to a NIC
 * that has gone. Ahead of the network, as a DNAT rule is built from the network's bridge, and
 * once that has gone nothing can construct the matching `-D`.
 */
export function deletePortForwardsForNetwork(networkId: string): Promise<void> {
  return oneChangeAtATime(async () => {
    await deleteForwardsWhere((f) => f.networkId === networkId);
    for (const r of await readReservations()) {
      if (r.networkId === networkId) await releaseReservationIfUnused(r.networkId, r.mac);
    }
  });
}

export function reserveVmIp(networkId: string, vmUuid: string, mac: string): Promise<string> {
  return oneChangeAtATime(async () => (await ensureReservation(networkId, vmUuid, mac)).ip);
}

export async function getReservationsForVm(vmUuid: string): Promise<DhcpReservation[]> {
  const reservations = await readReservations();
  return reservations.filter((r) => r.vmUuid === vmUuid);
}

// DNAT rules written by an older build (or under a different WAN interface)
// don't match the argument vector we generate now, so `-C` never sees them and
// `-D` can never remove them — they'd stay live forever, still hijacking other
// guests' egress. Strip every virtpilot-tagged PREROUTING rule out of the live
// table on startup; applyAllRules re-adds them in the current form from
// port-forwards.json, which is the authoritative list.
async function reconcileNatRules(): Promise<void> {
  const dump = await runSafe('iptables', [...WAIT, '-t', 'nat', '-S', 'PREROUTING']);
  if (dump === null) return;
  for (const line of dump.split('\n')) {
    const tokens = tokeniseIptablesRule(line.trim());
    if (tokens[0] !== '-A' || tokens[1] !== 'PREROUTING') continue;
    const commentIdx = tokens.indexOf('--comment');
    if (commentIdx === -1 || !tokens[commentIdx + 1]?.startsWith('virtpilot-')) continue;
    await runSafe('iptables', [...WAIT, '-t', 'nat', '-D', ...tokens.slice(1)]);
  }
}

/**
 * Every version from 2.7.0 to 2.16.4 moved a VM's firewall to the address of its newest port
 * forward, so the NIC it filters went unfiltered until the next Apply. On that evidence alone, a
 * firewall only on forwards' addresses with the NIC it filters not among them, that NIC's address
 * joins them. It leaves none: taking one away would open that forward to the world. Where else a
 * firewall sits is for Apply to say. Only asks libvirt on finding that. True while one waits for
 * its VM to have an address.
 */
async function extendMovedFirewalls(): Promise<boolean> {
  const forwards = await readForwards();
  let waiting = false;
  for (const vmUuid of new Set(forwards.map((f) => f.vmUuid))) {
    try {
      const mine = forwards.filter((f) => f.vmUuid === vmUuid);
      const held = await firewallAddresses(vmUuid);
      if (held === null) {
        waiting = true;
        continue;
      }
      if (held.length === 0 || !held.every((ip) => mine.some((f) => f.vmIp === ip))) continue;
      const vmService = await import('./vmService.js');
      if ((await vmService.findVm(vmUuid)) === null) continue;
      const nic = await vmService.firewallNicMac(vmUuid);
      if (nic && mine.some((f) => f.mac === nic && held.includes(f.vmIp))) continue;
      const { ip } = await vmService.resolveFirewallTarget(vmUuid);
      if (!nic || !ip) {
        waiting = true;
        continue;
      }
      if (held.includes(ip)) continue;
      await addFirewallAddress(vmUuid, ip);
      void logService.appendLog({
        type: 'vm.firewall.extend',
        subject: await lookupVmName(vmUuid),
        subjectUuid: vmUuid,
        status: 'success',
        output: `Firewall now also on ${ip}, the NIC it filters. An older version had left it only on ${held.join(', ')}, a port forward's address on another NIC. It stays there too.`,
      });
    } catch {
      waiting = true;
    }
  }
  return waiting;
}

/** After the backend is listening: it may ask libvirt, which can take a while at boot. */
export function startExtendingMovedFirewalls(): void {
  let wait = 30_000;
  const pass = async () => {
    if (await extendMovedFirewalls().catch(() => true)) {
      setTimeout(() => void pass(), wait).unref();
      wait = Math.min(wait * 2, 5 * 60_000);
    }
  };
  void pass();
}

export async function applyAllRules(): Promise<void> {
  const forwards = await readForwards();
  try {
    await reconcileNatRules();
  } catch (err) {
    console.warn('Failed to reconcile existing port-forward DNAT rules:', err);
  }
  const before = JSON.stringify(forwards);
  for (const fwd of forwards) {
    try {
      await addIptablesRules(fwd);
    } catch (err) {
      console.warn(`Failed to apply iptables rules for port forward ${fwd.id}:`, err);
    }
  }
  // addIptablesRules pins the ingress match it installed onto each record;
  // persist it so a later delete (in another process) can reproduce the exact
  // same vector instead of guessing.
  if (JSON.stringify(forwards) !== before) {
    await writeForwards(forwards).catch((err) => {
      console.warn('Failed to persist resolved port-forward ingress matches:', err);
    });
  }
}
