import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getNetwork, parseCidr, enumerateUsableIps } from './networkService.js';
import { tokeniseIptablesRule } from './firewallService.js';
import { run, runSafe, virsh } from './safeExec.js';
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

async function resolveCurrentVmIp(vmUuid: string, mac: string): Promise<string | null> {
  try {
    const stdout = await virsh(['domifaddr', validateVmUuid(vmUuid), '--source', 'arp']);
    for (const line of stdout.split('\n')) {
      if (line.toLowerCase().includes(mac.toLowerCase())) {
        const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (m) return m[1];
      }
    }
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
  const reservations = await readReservations();
  const existing = reservations.find((r) => r.networkId === networkId && r.mac === mac);
  if (existing) return { ip: existing.ip, created: false };

  const network = await getNetwork(networkId);
  if (!network || network.type !== 'nat' || !network.libvirtName) {
    throw new Error('Port forwards are only supported on NAT networks');
  }

  const { first } = parseCidr(network.cidr);
  const firstNum = ipToNum(first);
  const dhcpStartNum = network.gateway === first ? firstNum + 1 : firstNum;

  const takenIps = new Set([
    network.gateway,
    ...reservations.filter((r) => r.networkId === networkId).map((r) => r.ip),
  ]);

  const currentIp = await resolveCurrentVmIp(vmUuid, mac);
  const available = (currentIp && !takenIps.has(currentIp))
    ? currentIp
    : (() => {
        const usable = enumerateUsableIps(network.cidr);
        return usable.find((ip) => !takenIps.has(ip) && ipToNum(ip) >= dhcpStartNum) ?? null;
      })();

  if (!available) {
    throw new Error('No free IP addresses available in this NAT network for a DHCP reservation');
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
    console.warn('[port-forward] Could not determine the WAN interface — falling back to excluding the guest bridge on DNAT rules');
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

function forwardRuleArgs(fwd: PortForward, op: '-A' | '-D' | '-C'): string[] {
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

async function addIptablesRules(fwd: PortForward): Promise<void> {
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
  if (!fwdExists) await run('iptables', forwardRuleArgs(fwd, '-A'));
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

export async function createPortForward(opts: {
  networkId: string;
  vmUuid: string;
  mac: string;
  protocol: 'tcp' | 'udp';
  hostPort: number;
  vmPort: number;
  description?: string;
}): Promise<PortForward> {
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
    throw new Error(`Host port ${hostPort}/${protocol} is already forwarded to VM "${conflictName}"`);
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
    await addIptablesRules(forward);
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

export async function deletePortForward(id: string): Promise<void> {
  const forwards = await readForwards();
  const forward = forwards.find((f) => f.id === id);
  if (!forward) throw new Error(`Port forward ${id} not found`);

  await removeIptablesRules(forward);
  await writeForwards(forwards.filter((f) => f.id !== id));
  await releaseReservationIfUnused(forward.networkId, forward.mac);
}

export async function deletePortForwardsForVm(vmUuid: string): Promise<void> {
  const forwards = await readForwards();
  const mine = forwards.filter((f) => f.vmUuid === vmUuid);
  for (const fwd of mine) {
    await removeIptablesRules(fwd);
  }
  const remaining = forwards.filter((f) => f.vmUuid !== vmUuid);
  await writeForwards(remaining);
  for (const fwd of mine) {
    await releaseReservationIfUnused(fwd.networkId, fwd.mac);
  }
}

export async function reserveVmIp(networkId: string, vmUuid: string, mac: string): Promise<string> {
  return (await ensureReservation(networkId, vmUuid, mac)).ip;
}

// Deleting a network out from under a live port forward strands its DNAT rule:
// the forward's record still points at a network that no longer exists, so the
// ingress match can no longer be derived from disk. networkService must call
// this before removing a network.
export async function assertNetworkHasNoForwards(networkId: string): Promise<void> {
  const forwards = await readForwards();
  const inUse = forwards.filter((f) => f.networkId === networkId).length;
  if (inUse > 0) {
    throw new Error(
      `This network still has ${inUse} port forward${inUse === 1 ? '' : 's'}. Remove them before deleting the network.`
    );
  }
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
