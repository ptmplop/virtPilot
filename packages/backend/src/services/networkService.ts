import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { run, runSafe, virsh } from './safeExec.js';
import { validateBridgeName, validateNicName } from '../lib/validate.js';

export type NetworkType = 'nat' | 'bridge' | 'existing-bridge';
export type BridgeIpMode = 'dhcp' | 'static';

export interface Network {
  id: string;
  name: string;
  type: NetworkType;
  /** bridge only — how IPs are assigned to VMs */
  ipMode?: BridgeIpMode;
  cidr: string;
  gateway: string;
  dns: string[];
  bridge: string;
  /** bridge only — physical NIC enslaved to the bridge */
  physicalNic?: string;
  /** nat only — libvirt network name */
  libvirtName?: string;
  createdAt: string;
}

export interface IpAllocation {
  networkId: string;
  ip: string;
  vmName: string;
  /** MAC of the NIC that holds this IP */
  mac: string;
  allocatedAt: string;
}

export interface StaticIpConfig {
  ip: string;
  prefix: number;
  gateway: string;
  dns: string[];
}

export interface HostNic {
  name: string;
  mac: string;
  speed?: string;
  inUse: boolean;
  /** True if the NIC has active IPv4 addresses — unsafe to enslave without prior OS-level bridge config */
  hasIps: boolean;
}

const networksPath = () => path.join(config.storageRoot, 'networks.json');
const allocationsPath = () => path.join(config.storageRoot, 'ip-allocations.json');

async function readNetworks(): Promise<Network[]> {
  try {
    const raw: unknown[] = JSON.parse(await fs.readFile(networksPath(), 'utf8'));
    // Migrate legacy type names
    return raw.map((n: unknown) => {
      const net = n as Record<string, unknown>;
      if (net['type'] === 'local') {
        return { ...net, type: 'nat' } as unknown as Network;
      }
      if (net['type'] === 'public') {
        return { ...net, type: 'bridge', ipMode: 'static' } as unknown as Network;
      }
      return net as unknown as Network;
    });
  } catch {
    return [];
  }
}

async function writeNetworks(networks: Network[]): Promise<void> {
  await fs.writeFile(networksPath(), JSON.stringify(networks, null, 2), 'utf8');
}

async function readAllocations(): Promise<IpAllocation[]> {
  try {
    return JSON.parse(await fs.readFile(allocationsPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function writeAllocations(allocations: IpAllocation[]): Promise<void> {
  await fs.writeFile(allocationsPath(), JSON.stringify(allocations, null, 2), 'utf8');
}

function ipToNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function numToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

function isValidCidr(cidr: string): boolean {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o > 255)) return false;
  const prefix = parseInt(m[5], 10);
  return prefix >= 0 && prefix <= 32;
}

function cidrsOverlap(a: string, b: string): boolean {
  const pa = parseCidr(a);
  const pb = parseCidr(b);
  const aStart = ipToNum(pa.networkAddr);
  const aEnd = ipToNum(pa.broadcast);
  const bStart = ipToNum(pb.networkAddr);
  const bEnd = ipToNum(pb.broadcast);
  return aStart <= bEnd && bStart <= aEnd;
}

function checkCidrConflict(cidr: string, networks: Network[]): void {
  for (const n of networks) {
    if (cidrsOverlap(cidr, n.cidr)) {
      throw new Error(`CIDR ${cidr} overlaps with existing network "${n.name}" (${n.cidr})`);
    }
  }
}

export function parseCidr(cidr: string): { prefix: number; networkAddr: string; broadcast: string; first: string; last: string } {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = (prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1)) >>> 0;
  const networkNum = (ipToNum(base) & mask) >>> 0;
  const broadcastNum = (networkNum | (~mask >>> 0)) >>> 0;
  return {
    prefix,
    networkAddr: numToIp(networkNum),
    broadcast: numToIp(broadcastNum),
    first: numToIp(networkNum + 1),
    last: numToIp(broadcastNum - 1),
  };
}

export function enumerateUsableIps(cidr: string): string[] {
  const [base, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = (prefix === 0 ? 0 : ~((1 << (32 - prefix)) - 1)) >>> 0;
  const networkNum = (ipToNum(base) & mask) >>> 0;
  const broadcastNum = (networkNum | (~mask >>> 0)) >>> 0;
  const ips: string[] = [];
  for (let i = networkNum + 1; i < broadcastNum; i++) {
    ips.push(numToIp(i));
  }
  return ips;
}

function nextBridgeIndex(networks: Network[]): number {
  const indices = networks
    .map((n) => {
      const m = n.bridge.match(/^vp(\d+)$/);
      return m ? parseInt(m[1], 10) : -1;
    })
    .filter((i) => i >= 0);
  return indices.length === 0 ? 0 : Math.max(...indices) + 1;
}

export async function listNetworks(): Promise<Network[]> {
  return readNetworks();
}

export async function getNetwork(id: string): Promise<Network | null> {
  const networks = await readNetworks();
  return networks.find((n) => n.id === id) ?? null;
}

export async function createNatNetwork(opts: {
  name: string;
  cidr: string;
  gateway?: string;
  dns?: string[];
}): Promise<Network> {
  if (!isValidCidr(opts.cidr)) throw new Error(`Invalid CIDR notation: ${opts.cidr}`);
  const networks = await readNetworks();
  checkCidrConflict(opts.cidr, networks);
  const id = randomUUID();
  const bridge = `vp${nextBridgeIndex(networks)}`;
  const libvirtName = `virtpilot-${id.slice(0, 8)}`;
  const { prefix, first, last } = parseCidr(opts.cidr);
  const gateway = opts.gateway ?? first;
  const dns = opts.dns ?? ['8.8.8.8', '8.8.4.4'];
  const dhcpStart = gateway === first ? numToIp(ipToNum(first) + 1) : first;

  const xml = `<network>
  <name>${libvirtName}</name>
  <forward mode='nat'/>
  <bridge name='${bridge}' stp='on' delay='0'/>
  <ip address='${gateway}' prefix='${prefix}'>
    <dhcp>
      <range start='${dhcpStart}' end='${last}'/>
    </dhcp>
  </ip>
</network>`;

  const xmlPath = path.join(config.storageRoot, `net-${id}.xml`);
  await fs.writeFile(xmlPath, xml, 'utf8');
  try {
    await virsh(['net-define', xmlPath]);
    await virsh(['net-start', libvirtName]);
    await virsh(['net-autostart', libvirtName]);
  } finally {
    await fs.unlink(xmlPath).catch(() => {});
  }

  const network: Network = {
    id, name: opts.name, type: 'nat',
    cidr: opts.cidr, gateway, dns, bridge, libvirtName,
    createdAt: new Date().toISOString(),
  };
  await writeNetworks([...networks, network]);
  return network;
}

export async function createBridgeNetwork(opts: {
  name: string;
  cidr: string;
  gateway: string;
  ipMode: BridgeIpMode;
  dns?: string[];
  physicalNic?: string;
}): Promise<Network> {
  if (!isValidCidr(opts.cidr)) throw new Error(`Invalid CIDR notation: ${opts.cidr}`);
  const networks = await readNetworks();
  checkCidrConflict(opts.cidr, networks);
  const bridge = `vp${nextBridgeIndex(networks)}`;

  if (opts.physicalNic) {
    const nic = validateNicName(opts.physicalNic);
    const addrOut = await runSafe('ip', ['-4', 'addr', 'show', 'dev', nic, 'scope', 'global']) ?? '';
    if (/inet /.test(addrOut)) {
      throw new Error(
        `${nic} has active IP addresses — enslaving it would drop host connectivity. ` +
        `Configure the bridge at the OS level first (netplan / /etc/network/interfaces), ` +
        `then attach it here using "Existing OS bridge".`
      );
    }
  }

  const safeBridge = validateBridgeName(bridge);
  await run('ip', ['link', 'add', safeBridge, 'type', 'bridge']);
  await run('ip', ['link', 'set', safeBridge, 'up']);

  if (opts.physicalNic) {
    const nic = validateNicName(opts.physicalNic);
    await run('ip', ['link', 'set', nic, 'master', safeBridge]);
  }

  const network: Network = {
    id: randomUUID(),
    name: opts.name,
    type: 'bridge',
    ipMode: opts.ipMode,
    cidr: opts.cidr,
    gateway: opts.gateway,
    dns: opts.dns ?? ['8.8.8.8', '8.8.4.4'],
    bridge,
    physicalNic: opts.physicalNic,
    createdAt: new Date().toISOString(),
  };
  await writeNetworks([...networks, network]);
  return network;
}

export async function createExistingBridgeNetwork(opts: {
  name: string;
  bridge: string;
  cidr: string;
  gateway: string;
  ipMode: BridgeIpMode;
  dns?: string[];
}): Promise<Network> {
  const safeBridge = validateBridgeName(opts.bridge);
  const stdout = await runSafe('ip', ['link', 'show', 'dev', safeBridge, 'type', 'bridge']) ?? '';
  if (!stdout.trim()) {
    throw new Error(
      `Bridge "${opts.bridge}" does not exist on this host. ` +
      `Create it at the OS level first (netplan / /etc/network/interfaces / brctl).`
    );
  }
  if (!isValidCidr(opts.cidr)) throw new Error(`Invalid CIDR notation: ${opts.cidr}`);
  const networks = await readNetworks();
  checkCidrConflict(opts.cidr, networks);

  const network: Network = {
    id: randomUUID(),
    name: opts.name,
    type: 'existing-bridge',
    ipMode: opts.ipMode,
    cidr: opts.cidr,
    gateway: opts.gateway,
    dns: opts.dns ?? ['8.8.8.8', '8.8.4.4'],
    bridge: opts.bridge,
    createdAt: new Date().toISOString(),
  };
  await writeNetworks([...networks, network]);
  return network;
}

export async function deleteNetwork(id: string): Promise<void> {
  const networks = await readNetworks();
  const network = networks.find((n) => n.id === id);
  if (!network) throw new Error(`Network ${id} not found`);

  const allocations = await readAllocations();
  if (allocations.some((a) => a.networkId === id)) {
    throw new Error('Network has active IP allocations — delete the associated VMs first');
  }

  if (network.type === 'nat' && network.libvirtName) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(network.libvirtName)) throw new Error('Invalid libvirt network name');
    await runSafe('virsh', ['-c', config.libvirtUri, 'net-destroy', network.libvirtName]);
    await runSafe('virsh', ['-c', config.libvirtUri, 'net-undefine', network.libvirtName]);
  }

  // existing-bridge networks are OS-managed — never touch the bridge interface
  if (network.type === 'bridge' && /^vp\d+$/.test(network.bridge)) {
    if (network.physicalNic) {
      try {
        await runSafe('ip', ['link', 'set', validateNicName(network.physicalNic), 'nomaster']);
      } catch { /* already detached */ }
    }
    await runSafe('ip', ['link', 'set', network.bridge, 'down']);
    await runSafe('ip', ['link', 'delete', network.bridge]);
  }

  await writeNetworks(networks.filter((n) => n.id !== id));
}

export async function getNetworkIpStatus(id: string): Promise<{ ip: string; allocated: boolean; vmName?: string }[]> {
  const networks = await readNetworks();
  const network = networks.find((n) => n.id === id);
  if (!network || (network.type !== 'bridge' && network.type !== 'existing-bridge') || network.ipMode !== 'static') return [];

  const allocations = await readAllocations();
  const mine = allocations.filter((a) => a.networkId === id);
  const usable = enumerateUsableIps(network.cidr).filter((ip) => ip !== network.gateway);

  return usable.map((ip) => {
    const alloc = mine.find((a) => a.ip === ip);
    return { ip, allocated: !!alloc, vmName: alloc?.vmName };
  });
}

export async function allocateSpecificIp(networkId: string, vmName: string, mac: string, ip: string): Promise<void> {
  const allocations = await readAllocations();
  const conflict = allocations.find((a) => a.networkId === networkId && a.ip === ip);
  if (conflict) throw new Error(`IP ${ip} is already allocated to VM "${conflict.vmName}"`);
  await writeAllocations([
    ...allocations,
    { networkId, ip, vmName, mac, allocatedAt: new Date().toISOString() },
  ]);
}

export async function deallocateVmIps(vmName: string): Promise<void> {
  const allocations = await readAllocations();
  await writeAllocations(allocations.filter((a) => a.vmName !== vmName));
}

export async function deallocateByMac(mac: string): Promise<void> {
  const allocations = await readAllocations();
  await writeAllocations(allocations.filter((a) => a.mac !== mac));
}

export async function listPhysicalNics(): Promise<HostNic[]> {
  const entries = await fs.readdir('/sys/class/net');
  const networks = await readNetworks();
  const nics: HostNic[] = [];

  for (const name of entries) {
    // Skip loopback and known virtual prefixes
    if (name === 'lo') continue;

    // Only include physical devices (those with a device symlink in sysfs)
    try {
      await fs.access(`/sys/class/net/${name}/device`);
    } catch {
      continue;
    }

    let mac = '';
    let speed: string | undefined;
    let hasIps = false;

    try {
      mac = (await fs.readFile(`/sys/class/net/${name}/address`, 'utf8')).trim();
    } catch { /* ignore */ }

    try {
      const raw = (await fs.readFile(`/sys/class/net/${name}/speed`, 'utf8')).trim();
      const mb = parseInt(raw, 10);
      if (!isNaN(mb) && mb > 0) {
        speed = mb >= 1000 ? `${mb / 1000}Gb/s` : `${mb}Mb/s`;
      }
    } catch { /* interface may be down */ }

    try {
      // Sysfs only ever contains alphanumeric+:.-_ in interface names, but
      // we still validate before letting it ride in argv.
      const safeName = validateNicName(name);
      const addrOut = await runSafe('ip', ['-4', 'addr', 'show', 'dev', safeName, 'scope', 'global']) ?? '';
      hasIps = /inet /.test(addrOut);
    } catch { /* ignore */ }

    const inUse = networks.some((n) => n.physicalNic === name);
    nics.push({ name, mac, speed, inUse, hasIps });
  }

  return nics;
}
