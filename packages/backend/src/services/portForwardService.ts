import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getNetwork, parseCidr, enumerateUsableIps } from './networkService.js';

const execAsync = promisify(exec);

export interface PortForward {
  id: string;
  networkId: string;
  vmName: string;
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
  vmName: string;
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

async function resolveCurrentVmIp(vmName: string, mac: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`virsh -c qemu:///system domifaddr "${vmName}" --source arp`);
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
  const tmpFile = path.join(os.tmpdir(), `virtpilot-host-${randomUUID()}.xml`);
  await fs.writeFile(tmpFile, xml, 'utf8');
  try {
    try {
      await execAsync(`virsh net-update "${libvirtName}" ${op} ip-dhcp-host "${tmpFile}" --live --config`);
    } catch {
      // Network may not be running — fall back to config-only
      await execAsync(`virsh net-update "${libvirtName}" ${op} ip-dhcp-host "${tmpFile}" --config`);
    }
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function ensureReservation(networkId: string, vmName: string, mac: string): Promise<string> {
  const reservations = await readReservations();
  const existing = reservations.find((r) => r.networkId === networkId && r.mac === mac);
  if (existing) return existing.ip;

  const network = await getNetwork(networkId);
  if (!network || network.type !== 'nat' || !network.libvirtName) {
    throw new Error('Port forwards are only supported on NAT networks');
  }

  const { first } = parseCidr(network.cidr);
  const dhcpStart = network.gateway === first
    ? String.fromCharCode(0) // placeholder — recalculate below
    : first;

  const gatewayNum = ipToNum(network.gateway);
  const firstNum = ipToNum(first);
  // DHCP range starts just after gateway if gateway == first, else from first
  const dhcpStartNum = network.gateway === first ? firstNum + 1 : firstNum;

  const takenIps = new Set([
    network.gateway,
    ...reservations.filter((r) => r.networkId === networkId).map((r) => r.ip),
  ]);

  // Prefer the VM's current DHCP-assigned IP so the iptables rule works immediately
  // without requiring the VM to renew its lease.
  const currentIp = await resolveCurrentVmIp(vmName, mac);
  const available = (currentIp && !takenIps.has(currentIp))
    ? currentIp
    : (() => {
        const usable = enumerateUsableIps(network.cidr);
        return usable.find((ip) => !takenIps.has(ip) && ipToNum(ip) >= dhcpStartNum) ?? null;
      })();

  if (!available) {
    throw new Error('No free IP addresses available in this NAT network for a DHCP reservation');
  }

  await virshNetUpdate(network.libvirtName, 'add', `<host mac='${mac}' ip='${available}'/>`);

  const reservation: DhcpReservation = {
    networkId,
    libvirtName: network.libvirtName,
    mac,
    ip: available,
    vmName,
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

function natRuleCmd(fwd: PortForward, op: '-A' | '-D' | '-C'): string {
  return `iptables -t nat ${op} PREROUTING -p ${fwd.protocol} --dport ${fwd.hostPort} -j DNAT --to-destination ${fwd.vmIp}:${fwd.vmPort} -m comment --comment virtpilot-${fwd.id}`;
}

function forwardRuleCmd(fwd: PortForward, op: '-A' | '-D' | '-C'): string {
  return `iptables ${op} FORWARD -d ${fwd.vmIp} -p ${fwd.protocol} --dport ${fwd.vmPort} -j ACCEPT -m comment --comment virtpilot-${fwd.id}`;
}

async function addIptablesRules(fwd: PortForward): Promise<void> {
  const [natExists, fwdExists] = await Promise.all([
    execAsync(natRuleCmd(fwd, '-C')).then(() => true).catch(() => false),
    execAsync(forwardRuleCmd(fwd, '-C')).then(() => true).catch(() => false),
  ]);
  if (!natExists) await execAsync(natRuleCmd(fwd, '-A'));
  if (!fwdExists) await execAsync(forwardRuleCmd(fwd, '-A'));
}

async function removeIptablesRules(fwd: PortForward): Promise<void> {
  await execAsync(natRuleCmd(fwd, '-D')).catch(() => {});
  await execAsync(forwardRuleCmd(fwd, '-D')).catch(() => {});
}

export async function listPortForwards(networkId?: string): Promise<PortForward[]> {
  const forwards = await readForwards();
  return networkId ? forwards.filter((f) => f.networkId === networkId) : forwards;
}

export async function getPortForwardsForVm(vmName: string): Promise<PortForward[]> {
  const forwards = await readForwards();
  return forwards.filter((f) => f.vmName === vmName);
}

export async function createPortForward(opts: {
  networkId: string;
  vmName: string;
  mac: string;
  protocol: 'tcp' | 'udp';
  hostPort: number;
  vmPort: number;
  description?: string;
}): Promise<PortForward> {
  if (opts.hostPort < 1 || opts.hostPort > 65535) throw new Error('Host port must be between 1 and 65535');
  if (opts.vmPort < 1 || opts.vmPort > 65535) throw new Error('VM port must be between 1 and 65535');

  const forwards = await readForwards();
  const conflict = forwards.find((f) => f.hostPort === opts.hostPort && f.protocol === opts.protocol);
  if (conflict) {
    throw new Error(`Host port ${opts.hostPort}/${opts.protocol} is already forwarded to VM "${conflict.vmName}"`);
  }

  const vmIp = await ensureReservation(opts.networkId, opts.vmName, opts.mac);

  const forward: PortForward = {
    id: randomUUID(),
    networkId: opts.networkId,
    vmName: opts.vmName,
    mac: opts.mac,
    vmIp,
    protocol: opts.protocol,
    hostPort: opts.hostPort,
    vmPort: opts.vmPort,
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

export async function deletePortForwardsForVm(vmName: string): Promise<void> {
  const forwards = await readForwards();
  const mine = forwards.filter((f) => f.vmName === vmName);
  for (const fwd of mine) {
    await removeIptablesRules(fwd);
  }
  const remaining = forwards.filter((f) => f.vmName !== vmName);
  await writeForwards(remaining);
  // Clean up DHCP reservations for all removed forwards
  for (const fwd of mine) {
    await releaseReservationIfUnused(fwd.networkId, fwd.mac);
  }
}

export async function reserveVmIp(networkId: string, vmName: string, mac: string): Promise<string> {
  return ensureReservation(networkId, vmName, mac);
}

export async function getReservationsForVm(vmName: string): Promise<DhcpReservation[]> {
  const reservations = await readReservations();
  return reservations.filter((r) => r.vmName === vmName);
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
