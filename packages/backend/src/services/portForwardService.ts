import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getNetwork, parseCidr, enumerateUsableIps } from './networkService.js';
import { run, runSafe, virsh } from './safeExec.js';
import {
  validateVmUuid,
  validateMac,
  validateIpv4,
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

async function ensureReservation(networkId: string, vmUuid: string, macRaw: string): Promise<string> {
  const mac = validateMac(macRaw);
  const reservations = await readReservations();
  const existing = reservations.find((r) => r.networkId === networkId && r.mac === mac);
  if (existing) return existing.ip;

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
  return available;
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

function natRuleArgs(fwd: PortForward, op: '-A' | '-D' | '-C'): string[] {
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
    '-t', 'nat',
    op, 'PREROUTING',
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
    op, 'FORWARD',
    '-d', vmIp,
    '-p', proto,
    '--dport', String(vmPort),
    '-j', 'ACCEPT',
    '-m', 'comment', '--comment', `virtpilot-${fwd.id}`,
  ];
}

async function addIptablesRules(fwd: PortForward): Promise<void> {
  const [natExists, fwdExists] = await Promise.all([
    runSafe('iptables', natRuleArgs(fwd, '-C')).then((r) => r !== null),
    runSafe('iptables', forwardRuleArgs(fwd, '-C')).then((r) => r !== null),
  ]);
  if (!natExists) await run('iptables', natRuleArgs(fwd, '-A'));
  if (!fwdExists) await run('iptables', forwardRuleArgs(fwd, '-A'));
}

async function removeIptablesRules(fwd: PortForward): Promise<void> {
  await runSafe('iptables', natRuleArgs(fwd, '-D'));
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

  const vmIp = await ensureReservation(opts.networkId, vmUuid, mac);

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

  await addIptablesRules(forward);
  await writeForwards([...forwards, forward]);
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
  return ensureReservation(networkId, vmUuid, mac);
}

export async function getReservationsForVm(vmUuid: string): Promise<DhcpReservation[]> {
  const reservations = await readReservations();
  return reservations.filter((r) => r.vmUuid === vmUuid);
}

export async function applyAllRules(): Promise<void> {
  const forwards = await readForwards();
  for (const fwd of forwards) {
    try {
      await addIptablesRules(fwd);
    } catch (err) {
      console.warn(`Failed to apply iptables rules for port forward ${fwd.id}:`, err);
    }
  }
}
