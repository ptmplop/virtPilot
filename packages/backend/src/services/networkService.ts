import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { run, runSafe, virsh } from './safeExec.js';
import { validateBridgeName, validateNicName, validateNetworkName, validateIpv4, escapeXml } from '../lib/validate.js';
import { parseArpingReply, parseNeighbours } from '../lib/vmAddresses.js';
import { managedBridgeXml, planUplink } from '../lib/managedBridge.js';
import {
  VxlanInputError,
  defaultVxlanMtu,
  dhcpRange,
  nextFreeVni,
  parsePeers,
  parseVni,
  parseVxlanMtu,
  parseVxlanPort,
  vxlanBridgeName,
  vxlanDeviceName,
  vxlanNetworkXml,
} from '../lib/vxlan.js';
import * as bridgeService from './bridgeService.js';
import { bridgeExists, defineLibvirtNetwork, removeLibvirtNetwork } from './libvirtBridge.js';
import * as vxlanService from './vxlanService.js';

export type NetworkType = 'nat' | 'bridge' | 'existing-bridge' | 'vxlan';
export type BridgeIpMode = 'dhcp' | 'static';
/** vxlan only: 'none' leaves addresses to the guests, or to a DHCP server elsewhere on the network. */
export type NetworkIpMode = BridgeIpMode | 'none';

export interface Network {
  id: string;
  name: string;
  type: NetworkType;
  /** bridge and vxlan — how IPs are assigned to VMs */
  ipMode?: NetworkIpMode;
  /** Empty on a vxlan with ipMode 'none' */
  cidr: string;
  /** vxlan: with DHCP this host's own address on the network; with a static pool optional; never routes off it */
  gateway: string;
  dns: string[];
  bridge: string;
  /** bridge only — physical NIC enslaved to the bridge */
  physicalNic?: string;
  /** bridge only — the host has been seen using that NIC, so it is not taken while networkd still manages it */
  nicClaimed?: boolean;
  /** nat, vxlan and bridge — libvirt network name. A bridge from before 2.16.3 gets one at the next start */
  libvirtName?: string;
  /** vxlan only — the VXLAN ID */
  vni?: number;
  /** vxlan only — UDP port of the tunnel */
  vxlanPort?: number;
  /** vxlan only — MTU of the bridge, the tunnel and every NIC on it */
  mtu?: number;
  /** vxlan only — remote hosts, by address. None: this host alone, and the tunnel stays down */
  peers?: string[];
  createdAt: string;
}

/** A failure the API can report as it stands, with the status to report it under. */
export class NetworkError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export interface IpAllocation {
  networkId: string;
  ip: string;
  vmUuid: string;
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
  /** True if the NIC has a global address or the default route — unsafe to enslave without prior OS-level bridge config */
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
  // Write-then-rename: every boot rebuilds VXLANs from this file, so a crash
  // mid-write must leave the previous one intact, not a truncated one.
  const tmp = `${networksPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(networks, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, networksPath());
}

// One change at a time: two creates racing would both see the same ID and bridge
// free, and the second write would lose the first network's record.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// VMs on their way onto a network, which libvirt hasn't heard of yet. Making or cloning one can
// take hours, `virsh define` is happy with a bridge that has gone, and the next network made
// would take that bridge's name, with the VM on it.
const arriving = new Set<{ networks: readonly string[]; vm: string }>();
// Deletes under way, known by the same names. A hold from before one is marked is seen by its
// check of `arriving`, and one from after it waits to see how it ends.
const leaving = new Set<{ names: readonly string[]; done: Promise<void> }>();

const namesOf = (n: Pick<Network, 'id' | 'bridge' | 'libvirtName'>): string[] => [n.id, n.bridge, ...(n.libvirtName ? [n.libvirtName] : [])];

/**
 * Keeps these networks here until the returned function is called. Each is known by its ID, its
 * bridge or its libvirt name, as a VM's XML has them. A delete of one under way finishes first,
 * so look the networks up after this, not before; nothing else waits, and a queue held up by a
 * stalled libvirt must not hold up a VM being made.
 */
export async function holdNetworks(networks: readonly string[], vm: string): Promise<() => void> {
  for (;;) {
    const blocking = [...leaving].filter((d) => d.names.some((name) => networks.includes(name)));
    if (blocking.length === 0) break;
    await Promise.all(blocking.map((d) => d.done));
  }
  const hold = { networks, vm };
  arriving.add(hold);
  return () => { arriving.delete(hold); };
}

export function vmsArriving(network: Pick<Network, 'id' | 'bridge' | 'libvirtName'>): string[] {
  const names = namesOf(network);
  return [...new Set([...arriving].filter((hold) => hold.networks.some((name) => names.includes(name))).map((hold) => hold.vm))];
}

async function readAllocations(): Promise<IpAllocation[]> {
  let raw: string;
  try {
    raw = await fs.readFile(allocationsPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Not from here, as writes are atomic. Kept, as the next write would replace it.
    console.warn(`[network] ${allocationsPath()} can't be read as JSON: copying it to .corrupt and starting empty`);
    await fs.copyFile(allocationsPath(), `${allocationsPath()}.corrupt`).catch(() => {});
    return [];
  }
}

async function writeAllocations(allocations: IpAllocation[]): Promise<void> {
  const tmp = `${allocationsPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(allocations, null, 2), 'utf8');
  await fs.rename(tmp, allocationsPath());
}

// One change at a time, read to write. Measured with VMs made at the same moment: one address
// given to two of them, rows lost, and now and then every other pool's rows erased.
let allocationChanges: Promise<unknown> = Promise.resolve();
function changeAllocations(change: (current: IpAllocation[]) => IpAllocation[]): Promise<void> {
  const run = allocationChanges.then(async () => writeAllocations(change(await readAllocations())));
  allocationChanges = run.catch(() => {});
  return run;
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

export function ipInCidr(ip: string, cidr: string): boolean {
  if (!cidr) return false;
  const { networkAddr, broadcast } = parseCidr(cidr);
  const n = ipToNum(ip);
  return n >= ipToNum(networkAddr) && n <= ipToNum(broadcast);
}

// The gateway is interpolated into libvirt network XML and later handed to
// guest cloud-init, so it has to be a real address that actually sits in the
// network the operator asked for — otherwise libvirt silently builds a network
// no guest can route out of.
function assertGatewayInCidr(gateway: string, cidr: string): void {
  const { networkAddr, broadcast, prefix } = parseCidr(cidr);
  const lo = ipToNum(networkAddr);
  const hi = ipToNum(broadcast);
  const n = ipToNum(gateway);
  // /31 and /32 have no reserved network/broadcast address.
  const inRange = prefix >= 31 ? n >= lo && n <= hi : n > lo && n < hi;
  if (!inRange) {
    throw new NetworkError(`Gateway ${gateway} is not a usable address within ${cidr}`);
  }
}

function checkCidrConflict(cidr: string, networks: Network[]): void {
  for (const n of networks) {
    if (n.cidr && cidrsOverlap(cidr, n.cidr)) {
      throw new NetworkError(`CIDR ${cidr} overlaps with existing network "${n.name}" (${n.cidr})`, 409);
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

/** VirtPilot assigns this network's addresses from a pool: the NIC needs an IP chosen for it. */
export function usesStaticIps(n: Pick<Network, 'type' | 'ipMode'>): boolean {
  return n.type !== 'nat' && n.ipMode === 'static';
}

export function createNatNetwork(opts: Parameters<typeof createNatNetworkNow>[0]): Promise<Network> {
  return serialized(() => createNatNetworkNow(opts));
}

async function createNatNetworkNow(opts: {
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
  const gateway = validateIpv4(opts.gateway ?? first);
  assertGatewayInCidr(gateway, opts.cidr);
  const dns = opts.dns ?? ['8.8.8.8', '8.8.4.4'];
  const dhcpStart = gateway === first ? numToIp(ipToNum(first) + 1) : first;

  const xml = `<network>
  <name>${escapeXml(libvirtName)}</name>
  <forward mode='nat'/>
  <bridge name='${escapeXml(bridge)}' stp='on' delay='0'/>
  <ip address='${escapeXml(gateway)}' prefix='${prefix}'>
    <dhcp>
      <range start='${escapeXml(dhcpStart)}' end='${escapeXml(last)}'/>
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

export function createBridgeNetwork(opts: Parameters<typeof createBridgeNetworkNow>[0]): Promise<Network> {
  return serialized(() => createBridgeNetworkNow(opts));
}

async function createBridgeNetworkNow(opts: {
  name: string;
  cidr: string;
  gateway: string;
  ipMode: BridgeIpMode;
  dns?: string[];
  physicalNic?: string;
}): Promise<Network> {
  if (!isValidCidr(opts.cidr)) throw new Error(`Invalid CIDR notation: ${opts.cidr}`);
  const gateway = validateIpv4(opts.gateway);
  const networks = await readNetworks();
  checkCidrConflict(opts.cidr, networks);
  const bridge = `vp${nextBridgeIndex(networks)}`;
  const safeBridge = validateBridgeName(bridge);
  const nic = opts.physicalNic ? validateNicName(opts.physicalNic) : undefined;

  let plan: ReturnType<typeof planUplink> = { refusal: null, steps: [] };
  let nicWasUp = false;
  if (nic) {
    const holder = networks.find((n) => n.physicalNic === nic);
    if (holder) throw new NetworkError(`${nic} is already in use by network "${holder.name}".`, 409);
    let facts: Awaited<ReturnType<typeof bridgeService.readUplinkFacts>>;
    // Fail closed: if we can't read the NIC's addresses we don't know whether
    // enslaving it would cut the host off, so refuse rather than guess.
    try {
      facts = await bridgeService.readUplinkFacts(nic);
    } catch {
      throw new Error(`Could not inspect ${nic} - refusing to enslave a NIC whose IP configuration is unknown.`);
    }
    plan = planUplink(nic, safeBridge, facts);
    nicWasUp = facts.up;
    if (plan.refusal) {
      const hostDependsOnIt = facts.hasAddress || facts.defaultRoute;
      throw new NetworkError(
        hostDependsOnIt
          ? `${plan.refusal} Configure the bridge at the OS level first (netplan / /etc/network/interfaces), then attach it here using "Existing OS bridge".`
          : plan.refusal,
        409,
      );
    }
  }

  // Never adopt a pre-existing vpN device — it may belong to something else,
  // and the rollback below must only ever delete a bridge we created here.
  if ((await runSafe('ip', ['link', 'show', 'dev', safeBridge])) !== null) {
    throw new Error(
      `Interface "${safeBridge}" already exists on this host. ` +
      `Remove it (ip link delete ${safeBridge}) or attach it here using "Existing OS bridge".`
    );
  }

  const id = randomUUID();
  const libvirtName = bridgeService.libvirtNameFor(id);
  await defineLibvirtNetwork(libvirtName, managedBridgeXml({ libvirtName, bridge: safeBridge }));

  const network: Network = {
    id,
    name: opts.name,
    type: 'bridge',
    ipMode: opts.ipMode,
    cidr: opts.cidr,
    gateway,
    dns: opts.dns ?? ['8.8.8.8', '8.8.4.4'],
    bridge,
    physicalNic: nic,
    libvirtName,
    createdAt: new Date().toISOString(),
  };
  try {
    for (const args of plan.steps) await run('ip', args);
    await writeNetworks([...networks, network]);
  } catch (err) {
    // A half-built bridge is never written to networks.json, so nextBridgeIndex
    // would keep handing out the same vpN and every later create — NAT ones
    // included — would collide with the orphan. Tear it down before rethrowing.
    await removeLibvirtNetwork(libvirtName);
    if (nic && !nicWasUp) await runSafe('ip', ['link', 'set', nic, 'down']);
    throw err;
  }
  return network;
}

export function createExistingBridgeNetwork(opts: Parameters<typeof createExistingBridgeNetworkNow>[0]): Promise<Network> {
  return serialized(() => createExistingBridgeNetworkNow(opts));
}

async function createExistingBridgeNetworkNow(opts: {
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
  const gateway = validateIpv4(opts.gateway);
  const networks = await readNetworks();
  checkCidrConflict(opts.cidr, networks);

  const network: Network = {
    id: randomUUID(),
    name: opts.name,
    type: 'existing-bridge',
    ipMode: opts.ipMode,
    cidr: opts.cidr,
    gateway,
    dns: opts.dns ?? ['8.8.8.8', '8.8.4.4'],
    bridge: opts.bridge,
    createdAt: new Date().toISOString(),
  };
  await writeNetworks([...networks, network]);
  return network;
}

// ─── VXLAN ────────────────────────────────────────────────────────────────────

export interface VxlanIdUse {
  vni: number;
  /** In words: a VirtPilot network's name, or an interface VirtPilot did not create. */
  usedBy: string;
}

/** Every VXLAN ID taken on this host. The kernel is asked too: an ID in use outside VirtPilot exists just the same. */
async function readVxlanIdUses(networks: Network[]): Promise<VxlanIdUse[]> {
  const uses: VxlanIdUse[] = networks
    .filter((n) => n.vni !== undefined)
    .map((n) => ({ vni: n.vni!, usedBy: `network "${n.name}"` }));
  for (const link of await vxlanService.readVxlanLinks()) {
    if (!uses.some((u) => u.vni === link.vni)) uses.push({ vni: link.vni, usedBy: `interface ${link.name} on this host` });
  }
  return uses;
}

export async function listVxlanIds(): Promise<{ next: number | null; used: VxlanIdUse[] }> {
  const used = await readVxlanIdUses(await readNetworks());
  return { next: nextFreeVni(used.map((u) => u.vni)), used };
}

function vxlanAddressing(
  opts: { ipMode: NetworkIpMode; cidr?: string; gateway?: string },
  networks: Network[],
): { cidr: string; gateway: string; prefix: number; first: string; last: string } | null {
  if (opts.ipMode === 'none') return null;
  if (typeof opts.cidr !== 'string' || !isValidCidr(opts.cidr)) throw new NetworkError('Give the network an address range, like 10.0.2.0/24.');
  const { prefix, networkAddr, first, last } = parseCidr(opts.cidr);
  if (prefix > 30) throw new NetworkError(`${opts.cidr} is too small: it leaves no room for VMs. Use /30 or larger.`);
  // Every address of a static pool is listed in the VM wizard's picker.
  if (opts.ipMode === 'static' && prefix < 16) throw new NetworkError(`${opts.cidr} is too large for a static pool. Use /16 or smaller.`);
  const cidr = `${networkAddr}/${prefix}`;
  checkCidrConflict(cidr, networks);
  const gateway = opts.gateway ? validateIpv4(opts.gateway) : opts.ipMode === 'dhcp' ? first : '';
  if (gateway) assertGatewayInCidr(gateway, cidr);
  return { cidr, gateway, prefix, first, last };
}

export function createVxlanNetwork(opts: Parameters<typeof createVxlanNetworkNow>[0]): Promise<Network> {
  return serialized(() => createVxlanNetworkNow(opts));
}

async function createVxlanNetworkNow(opts: {
  name: unknown;
  /** Absent: the next available ID. */
  vni?: unknown;
  ipMode: NetworkIpMode;
  cidr?: string;
  gateway?: string;
  peers?: unknown;
  mtu?: unknown;
  port?: unknown;
}): Promise<Network> {
  let name: string;
  try {
    name = validateNetworkName(opts.name);
  } catch {
    throw new VxlanInputError('A network name starts with a letter or number and has only letters, numbers, dots, hyphens and underscores.');
  }
  if (!['dhcp', 'static', 'none'].includes(opts.ipMode)) throw new VxlanInputError('ipMode must be "dhcp", "static" or "none".');

  const networks = await readNetworks();
  if (networks.some((n) => n.name === name)) throw new NetworkError(`A network named "${name}" already exists.`, 409);

  // Everything that can be refused is refused before the host is touched.
  const uses = await readVxlanIdUses(networks);
  const asked = opts.vni === undefined || opts.vni === null || opts.vni === '' ? null : parseVni(opts.vni);
  const vni = asked ?? nextFreeVni(uses.map((u) => u.vni));
  if (vni === null) throw new NetworkError('Every VXLAN ID on this host is taken.', 409);
  const clash = uses.find((u) => u.vni === vni);
  if (clash) throw new NetworkError(`VXLAN ID ${vni} already exists: it is used by ${clash.usedBy}. Choose another, or use the next available ID.`, 409);

  const port = parseVxlanPort(opts.port);
  const mtu = parseVxlanMtu(opts.mtu) ?? defaultVxlanMtu(await vxlanService.underlayMtu());
  const addressing = vxlanAddressing(opts, networks);
  const peers = parsePeers(opts.peers, await vxlanService.hostAddresses(), (ip) => ipInCidr(ip, addressing?.cidr ?? ''));

  const bridge = vxlanBridgeName(vni);
  for (const name of [vxlanDeviceName(vni), bridge]) {
    if (await vxlanService.interfaceExists(name)) {
      throw new NetworkError(`Interface ${name} already exists on this host. Remove it (ip link delete ${name}) or choose another ID.`, 409);
    }
  }

  const id = randomUUID();
  const libvirtName = `virtpilot-${id.slice(0, 8)}`;

  const dhcp = opts.ipMode === 'dhcp' && addressing
    ? {
        address: addressing.gateway,
        prefix: addressing.prefix,
        ...dhcpRange(addressing.first, addressing.last, addressing.gateway),
      }
    : undefined;
  await defineLibvirtNetwork(libvirtName, vxlanNetworkXml({ libvirtName, bridge, mtu, dhcp }));

  const network: Network = {
    id, name, type: 'vxlan', ipMode: opts.ipMode,
    cidr: addressing?.cidr ?? '', gateway: addressing?.gateway ?? '', dns: [],
    bridge, libvirtName, vni, vxlanPort: port, mtu, peers,
    createdAt: new Date().toISOString(),
  };

  try {
    const problems = (await vxlanService.syncVxlanNetworks([...networks, network])).get(id);
    if (problems) throw new NetworkError(problems.join(' '), 500);
    await writeNetworks([...networks, network]);
  } catch (err) {
    await vxlanService.removeVxlanDevice(vni);
    await removeLibvirtNetwork(libvirtName);
    await vxlanService.syncVxlanNetworks(networks);
    throw err;
  }
  return network;
}

export function updateVxlanPeers(id: string, peers: unknown): Promise<Network> {
  return serialized(async () => {
    const networks = await readNetworks();
    const current = networks.find((n) => n.id === id);
    if (!current) throw new NetworkError('Network not found', 404);
    if (current.type !== 'vxlan') throw new NetworkError('Only a VXLAN has remote hosts.');
    const updated: Network = { ...current, peers: parsePeers(peers, await vxlanService.hostAddresses(), (ip) => ipInCidr(ip, current.cidr)) };
    const next = networks.map((n) => (n.id === id ? updated : n));
    const problems = (await vxlanService.syncVxlanNetworks(next)).get(id);
    if (problems) {
      await vxlanService.syncVxlanNetworks(networks);
      throw new NetworkError(problems.join(' '), 500);
    }
    await writeNetworks(next);
    return updated;
  });
}

const lastLogged = new Map<string, string>();

function logProblems(tag: string, networks: readonly Network[], problems: Map<string, string[]>): void {
  for (const n of networks) {
    const said = problems.get(n.id)?.join(' ') ?? '';
    if (said && said !== lastLogged.get(n.id)) console.warn(`[${tag}] ${n.name}: ${said}`);
    if (said) lastLogged.set(n.id, said);
    else lastLogged.delete(n.id);
  }
}

/**
 * Rebuild what doesn't survive a reboot (device, remote hosts, firewall rules;
 * libvirt brings the bridge back itself) and put back anything that has gone since,
 * such as a flushed firewall or a libvirt network restarted by hand.
 */
export function applyVxlanNetworks(): Promise<void> {
  return serialized(async () => {
    const networks = await readNetworks();
    const problems = await vxlanService.syncVxlanNetworks(networks);
    logProblems('vxlan', networks.filter((n) => n.type === 'vxlan'), problems);
  });
}

/**
 * Put each managed bridge's NIC back on it after a boot (libvirt brings the bridge back
 * itself), put back anything that has gone since, and give a bridge from before 2.16.3
 * its libvirt network.
 */
export function applyBridgeNetworks(): Promise<void> {
  return serialized(async () => {
    const networks = await readNetworks();
    if (!networks.some(bridgeService.isManagedBridge)) return;
    const { networks: next, problems } = await bridgeService.syncManagedBridges(networks);
    if (next !== networks) await writeNetworks(next);
    logProblems('bridge', next.filter(bridgeService.isManagedBridge), problems);
  });
}

export function startNetworkWatch(intervalMs = 30_000): void {
  // One pass at a time: against a stalled libvirt a pass can outlast the interval, and
  // queueing another each time would only make everything behind them wait longer.
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      const networks = await readNetworks();
      await applyBridgeNetworks().catch((err) => console.warn('[bridge] Check failed:', err));
      if ((await vxlanService.anyVxlanDevice()) || networks.some((n) => n.type === 'vxlan')) await applyVxlanNetworks();
    })().catch((err) => console.warn('[vxlan] Check failed:', err)).finally(() => { busy = false; });
  }, intervalMs).unref();
}

/**
 * Bring back the bridge of any VXLAN or managed bridge a VM is about to start on, so it
 * starts rather than fails with libvirt's "Cannot get interface MTU". Pays nothing unless
 * one is missing, and never holds a start up for long: what can't come back in time is
 * said at the start.
 */
export async function ensureBridges(bridges: readonly string[], waitMs = 15_000): Promise<void> {
  const wanted = (await readNetworks()).filter((n) => (n.type === 'vxlan' || bridgeService.isManagedBridge(n)) && bridges.includes(n.bridge));
  const present = await Promise.all(wanted.map((n) => bridgeExists(n.bridge)));
  if (present.every(Boolean)) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all([applyBridgeNetworks().catch(() => {}), applyVxlanNetworks().catch(() => {})]),
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(timer);
}

export function deleteNetwork(id: string): Promise<void> {
  return serialized(() => deleteNetworkHolding(id));
}

async function deleteNetworkHolding(id: string): Promise<void> {
  const networks = await readNetworks();
  const network = networks.find((n) => n.id === id);
  if (!network) throw new NetworkError(`Network ${id} not found`, 404);
  let finished = () => {};
  const mark = { names: namesOf(network), done: new Promise<void>((resolve) => { finished = resolve; }) };
  leaving.add(mark);
  try {
    await deleteNetworkNow(network, networks);
  } finally {
    leaving.delete(mark);
    finished();
  }
}

async function deleteNetworkNow(network: Network, networks: Network[]): Promise<void> {
  const { id } = network;
  let allocations = await readAllocations();

  // A VM left on a deleted network of VirtPilot's would refuse to start. An OS bridge stays
  // when its record goes, so a VM on one is fine. Lazy import: vmService imports this module.
  // It throws if libvirt can't say, and that refuses the delete.
  if (network.type === 'nat' || network.type === 'vxlan' || bridgeService.isManagedBridge(network)) {
    const kind = network.type === 'vxlan' ? 'VXLAN' : network.type === 'nat' ? 'NAT network' : 'bridge';
    const coming = vmsArriving(network);
    if (coming.length > 0) {
      throw new NetworkError(`${coming.join(', ')} ${coming.length === 1 ? 'is' : 'are'} being added to this ${kind}. Wait for that to finish.`, 409);
    }
    const all = await (await import('./vmService.js')).listVmsWithNics([network]);
    const vms = all.filter((vm) => vm.nics.some((nic) => nic.source === network.bridge)).map((vm) => vm.name);
    if (vms.length > 0) {
      throw new NetworkError(`${vms.join(', ')} ${vms.length === 1 ? 'is' : 'are'} still connected to this ${kind}. Remove ${vms.length === 1 ? 'its NIC' : 'their NICs'} first.`, 409);
    }
    // No VM is on it, so what is left in the pool belongs to VMs that are gone: nothing
    // could ever release it, and it must not keep the network here for good. Except a VM
    // being made right now, which holds an address before libvirt has heard of it. Read
    // again: this file has writers outside the queue, and asking libvirt took a while.
    const settled = Date.now() - 5 * 60_000;
    await changeAllocations((held) => held.filter((a) => a.networkId !== id || Date.parse(a.allocatedAt) > settled));
    allocations = await readAllocations();
  }

  if (allocations.some((a) => a.networkId === id)) {
    throw new Error('Network has active IP allocations - delete the associated VMs first');
  }

  // Only a NAT network has port forwards. Lazy import: portForwardService imports this module.
  if (network.type === 'nat') await (await import('./portForwardService.js')).deletePortForwardsForNetwork(id);

  // Hand-edited at worst, and the record can still go: virsh gets it as one argument.
  const libvirtName = network.libvirtName && /^[A-Za-z0-9._-]{1,64}$/.test(network.libvirtName) ? network.libvirtName : undefined;

  // Ahead of the bridge going, and only if it is still ours to take: the operator may have
  // moved this NIC somewhere the host depends on since.
  if (bridgeService.isManagedBridge(network) && network.physicalNic) {
    try {
      const nic = validateNicName(network.physicalNic);
      if ((await bridgeService.nicMaster(nic)) === network.bridge) {
        await runSafe('ip', ['link', 'set', nic, 'nomaster']);
        // Not with something else on it: the host may be reached through a VLAN on this NIC.
        if (!(await bridgeService.hasUpperDevice(nic))) await runSafe('ip', ['link', 'set', nic, 'down']);
      }
    } catch { /* a record edited by hand: that name was never on the bridge */ }
  }

  if (network.type !== 'existing-bridge' && libvirtName) {
    // The device before anything else: its socket closes with it, so at no point
    // is a tunnel up without its firewall rules.
    if (network.vni !== undefined) await vxlanService.removeVxlanDevice(network.vni);
    await removeLibvirtNetwork(libvirtName);
  }

  // Still there after that: a plain bridge from before 2.16.3, not yet through a boot.
  // existing-bridge networks are OS-managed — never touch the bridge interface
  if (bridgeService.isManagedBridge(network) && await bridgeExists(network.bridge)) {
    await runSafe('ip', ['link', 'set', network.bridge, 'down']);
    await runSafe('ip', ['link', 'delete', network.bridge]);
  }

  const remaining = networks.filter((n) => n.id !== id);
  await writeNetworks(remaining);
  if (network.type === 'vxlan') await vxlanService.syncVxlanNetworks(remaining);
}

/** The host's own addresses on a bridge. It never hears its own ARP, so no probe can find these. */
async function hostAddresses(bridge: string): Promise<string[]> {
  const out = await runSafe('ip', ['-4', '-o', 'addr', 'show', 'dev', validateBridgeName(bridge)], { timeout: 5_000 });
  return [...(out ?? '').matchAll(/\binet (\d{1,3}(?:\.\d{1,3}){3})\//g)].map((m) => m[1]);
}

/** libvirt's answer if it comes in a few seconds. It only ever adds to what is known, and a guest's hung agent can hold it up. */
function guestsOnSoon(network: Network) {
  return Promise.race([
    import('./vmService.js').then((vmService) => vmService.guestsOn(network)).catch(() => null),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000).unref(); }),
  ]);
}

/**
 * Addresses in use on a pool's bridge that it didn't hand out, as a guest can set its own: the
 * host's own, what its neighbour table has, and what guest agents report. A VM's UUID where one
 * can be told. Costs a few processes and is read when a pool is shown, not on a timer. Never holds
 * that up for long: libvirt only adds to what is known, and taking an address probes it anyway.
 */
// What guests on a static pool were last seen using. Nobody can ask a stopped guest what address it
// has set itself, but it will want it back when it starts, and the pool remembers it having it.
interface SeenAddress {
  networkId: string;
  mac: string;
  ip: string;
  vmUuid: string;
  seenAt: string;
}

const seenPath = () => path.join(config.storageRoot, 'seen-addresses.json');

async function readSeen(): Promise<SeenAddress[]> {
  try {
    return JSON.parse(await fs.readFile(seenPath(), 'utf8')) as SeenAddress[];
  } catch {
    return [];
  }
}

// A guest's latest address replaces its last, and one with none to report keeps what it had: that
// is every stopped VM. Only VMs libvirt says are on the pool's bridge: throwing if it can't say
// keeps the book as it was, where a wrong answer would have emptied it.
async function noteGuestAddresses(networks: readonly Network[]): Promise<void> {
  const pools = networks.filter(usesStaticIps);
  const before = await readSeen();
  if (pools.length === 0 && before.length === 0) return;
  const vms = await (await import('./vmService.js')).listVmsWithNics(networks);
  const now = new Date().toISOString();
  const after: SeenAddress[] = [];
  for (const pool of pools) {
    const onPool = new Map(vms.flatMap((vm) => vm.nics.filter((n) => n.source === pool.bridge).map((n) => [n.mac.toLowerCase(), vm.id] as const)));
    const guests = await guestsOnSoon(pool);
    const table = await runSafe('ip', ['-4', 'neigh', 'show', 'dev', validateBridgeName(pool.bridge)], { timeout: 5_000 }) ?? '';
    const onIt = ({ ip, mac }: { ip: string; mac: string }) => onPool.has(mac) && ipInCidr(ip, pool.cidr);
    const heard = [...parseNeighbours(table), ...(guests?.addresses ?? [])].filter(onIt);
    // A quiet guest's entry goes stale in seconds. It still says what that guest last used, unless
    // there is something newer to go on.
    const heardBefore = parseNeighbours(table, { stale: true }).filter(onIt);
    for (const [mac, vmUuid] of onPool) {
      const fresh = heard.filter((h) => h.mac === mac);
      const mine = fresh.length > 0 ? fresh : heardBefore.filter((h) => h.mac === mac);
      if (mine.length > 0) {
        for (const ip of new Set(mine.map((h) => h.ip))) after.push({ networkId: pool.id, mac, ip, vmUuid, seenAt: now });
      } else {
        after.push(...before.filter((row) => row.networkId === pool.id && row.mac === mac));
      }
    }
  }
  const tmp = `${seenPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(after, null, 2), 'utf8');
  await fs.rename(tmp, seenPath());
}

/** Costs nothing with no static pool. On a timer of its own, as an agent or a stalled libvirt can hold a pass up. */
export function startPoolWatch(intervalMs = 30_000): void {
  let busy = false;
  const pass = () => {
    if (busy) return;
    busy = true;
    void readNetworks().then(noteGuestAddresses).catch((err) => console.warn('[network] Could not note guest addresses:', err)).finally(() => { busy = false; });
  };
  pass();
  setInterval(pass, intervalMs).unref();
}

async function addressesInUse(network: Network): Promise<Map<string, string | undefined>> {
  const guests = await guestsOnSoon(network);
  const neighbours = parseNeighbours(await runSafe('ip', ['-4', 'neigh', 'show', 'dev', validateBridgeName(network.bridge)], { timeout: 5_000 }) ?? '');
  const inUse = new Map<string, string | undefined>();
  for (const row of await readSeen()) {
    if (row.networkId === network.id) inUse.set(row.ip, row.vmUuid);
  }
  for (const ip of await hostAddresses(network.bridge)) inUse.set(ip, undefined);
  for (const { ip, mac } of [...neighbours, ...(guests?.addresses ?? [])]) inUse.set(ip, guests?.owner.get(mac) ?? inUse.get(ip));
  return inUse;
}

export async function getNetworkIpStatus(id: string): Promise<{ ip: string; allocated: boolean; vmUuid?: string; inUse?: boolean }[]> {
  const networks = await readNetworks();
  const network = networks.find((n) => n.id === id);
  if (!network || !usesStaticIps(network)) return [];

  const inUse = await addressesInUse(network).catch(() => new Map<string, string | undefined>());
  const allocations = await readAllocations();
  const mine = allocations.filter((a) => a.networkId === id);
  const usable = enumerateUsableIps(network.cidr).filter((ip) => ip !== network.gateway);

  return usable.map((ip) => {
    const alloc = mine.find((a) => a.ip === ip);
    if (alloc) return { ip, allocated: true, vmUuid: alloc.vmUuid };
    return inUse.has(ip) ? { ip, allocated: true, inUse: true, vmUuid: inUse.get(ip) } : { ip, allocated: false };
  });
}

/**
 * Who answers for an address on a bridge, by ARP, which a guest's own firewall doesn't touch.
 * Needs no address on the bridge, as `-D` asks from 0.0.0.0. Three tries a second apart, for a guest
 * that is busy or a request that is lost, so it takes three seconds when nobody answers.
 * Null too where it can't tell: no arping on this host, or the bridge is down.
 */
async function arpHolder(bridge: string, ip: string): Promise<string | null> {
  try {
    await run('arping', ['-D', '-c', '3', '-w', '3', '-I', validateBridgeName(bridge), validateIpv4(ip)], { timeout: 6_000 });
    return null;
  } catch (err) {
    return parseArpingReply(String((err as { stdout?: unknown }).stdout ?? ''), ip);
  }
}

/** A guest with no agent that set its own address, or any other machine on a bridge to a LAN. */
async function refuseIfInUse(network: Network, ip: string, forVm: string): Promise<void> {
  if ((await hostAddresses(network.bridge)).includes(ip)) {
    throw new NetworkError(`${ip} is this host's own address on ${network.name}. Choose another.`, 409);
  }
  // Ahead of asking: a stopped guest won't answer. If libvirt can't say it is still there, it counts.
  const seen = (await readSeen()).find((row) => row.networkId === network.id && row.ip === ip && row.vmUuid !== forVm);
  if (seen) {
    const vm = await (await import('./vmService.js')).findVm(seen.vmUuid).catch(() => undefined);
    if (vm !== null) throw new NetworkError(`${ip} is in use on ${network.name}: ${vm?.name ?? 'another VM'} had it when last seen. Choose another.`, 409);
  }
  const holder = await arpHolder(network.bridge, ip);
  if (!holder) return;
  // A router doing proxy ARP answers for the whole subnet, and everything would look taken.
  if (network.gateway && (await arpHolder(network.bridge, network.gateway)) === holder) return;
  const vm = await guestsOnSoon(network);
  const uuid = vm?.owner.get(holder);
  const name = uuid ? vm?.names.get(uuid) : undefined;
  throw new NetworkError(`${ip} is already in use on ${network.name}: ${name ?? `a machine with MAC ${holder}`} answers for it. Choose another.`, 409);
}

export async function allocateSpecificIp(networkId: string, vmUuid: string, mac: string, ip: string): Promise<void> {
  try {
    validateIpv4(ip);
  } catch {
    throw new NetworkError(`${ip} is not an IPv4 address.`);
  }
  const network = await getNetwork(networkId);
  if (network) {
    const { networkAddr, broadcast } = parseCidr(network.cidr);
    const n = ipToNum(ip);
    if (n <= ipToNum(networkAddr) || n >= ipToNum(broadcast) || ip === network.gateway) {
      throw new NetworkError(`${ip} is not a free address on ${network.name} (${network.cidr}).`);
    }
    // Ahead of the file, as this takes seconds.
    await refuseIfInUse(network, ip, vmUuid);
  }
  await changeAllocations((allocations) => {
    const conflict = allocations.find((a) => a.networkId === networkId && a.ip === ip);
    if (conflict) throw new NetworkError(`IP ${ip} is already allocated to VM "${conflict.vmUuid}"`, 409);
    return [...allocations, { networkId, ip, vmUuid, mac, allocatedAt: new Date().toISOString() }];
  });
}

const started = Date.now();

/**
 * Called once the backend is listening. A restart ends any VM being made, and its address would
 * stay taken for good, as nothing else clears a row whose VM never arrived: on an OS bridge's pool
 * that also blocks deleting the record. Only rows from before this start, as any later one may
 * be a VM on its way, and only for what libvirt says it has no record of.
 */
export async function dropAllocationsOfMissingVms(): Promise<void> {
  const vmService = await import('./vmService.js');
  const older = (await readAllocations()).filter((a) => Date.parse(a.allocatedAt) < started);
  const missing = new Set<string>();
  for (const vmUuid of new Set(older.map((a) => a.vmUuid))) {
    if ((await vmService.findVm(vmUuid).catch(() => undefined)) === null) missing.add(vmUuid);
  }
  if (missing.size === 0) return;
  await changeAllocations((current) => current.filter((a) => !(missing.has(a.vmUuid) && Date.parse(a.allocatedAt) < started)));
  console.log(`[network] Freed the addresses of ${missing.size} VM(s) that never arrived or no longer exist`);
}

export function deallocateVmIps(vmUuid: string): Promise<void> {
  return changeAllocations((allocations) => allocations.filter((a) => a.vmUuid !== vmUuid));
}

export function deallocateByMac(mac: string): Promise<void> {
  return changeAllocations((allocations) => allocations.filter((a) => a.mac !== mac));
}

export async function listPhysicalNics(): Promise<HostNic[]> {
  const entries = await fs.readdir('/sys/class/net');
  const networks = await readNetworks();
  const routes = await bridgeService.defaultRouteDevices().catch(() => [] as string[]);
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
      hasIps = routes.includes(safeName) || await bridgeService.hasGlobalAddress(safeName);
    } catch { /* ignore */ }

    const inUse = networks.some((n) => n.physicalNic === name) || (await bridgeService.nicMaster(name)) !== null;
    nics.push({ name, mac, speed, inUse, hasIps });
  }

  return nics;
}
