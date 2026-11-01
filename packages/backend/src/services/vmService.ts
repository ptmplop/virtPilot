import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import * as storageDirService from './storageDirService.js';
import { listVmMetas } from './vmMetaService.js';
import { ensureBridges, ipInCidr, listNetworks, NetworkError, type Network } from './networkService.js';
import { getRecentVmCpu, guestMemory } from './vmMetricsService.js';
import type { Vm, VmDisk, VmNic, VmStatus, VmSnapshot, VmSummary, VmStatsSample, VmStatsResponse } from '../types.js';
import { type TraceEntry, formatTrace } from './traceService.js';
import { run, virsh as safeVirsh, virshBatch, qemuImg } from './safeExec.js';
import * as deviceService from './deviceService.js';
import { DeviceError } from './deviceService.js';
import { parseHostdevs, portableHostdevXml, stripBackingStores, stripHostdevs } from '../lib/hostdevXml.js';
import { parseDhcpLeases, parseDomIfAddr, pickVmIp, type NicAddress } from '../lib/vmAddresses.js';
import { isBatchWord } from '../lib/virshBatch.js';
import { buildInterfaceXml } from './xmlBuilder.js';
import {
  validateVmName,
  validateSnapshotName,
  validateBridgeName,
  validateMac,
  validateDiskTarget,
  validateNicModel,
  validateNonNegativeInt,
} from '../lib/validate.js';

// Most callers now pass a UUID; listVmsRaw() still reads each VM by its
// name, so internal validators must accept both shapes. validateVmName's regex (`[A-Za-z0-9][A-Za-z0-9._-]{0,62}`)
// permits the 36-character RFC 4122 form, so it's safe to use here.

// ─── Internal virsh helper ────────────────────────────────────────────────────

// Thin wrapper over safeExec.virsh that records the invocation in `trace`
// when one is supplied.
async function virsh(args: readonly string[], trace?: TraceEntry[], timeout = 30_000): Promise<string> {
  return safeVirsh(args, { timeout, trace });
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseStatus(state: string): VmStatus {
  const s = state.toLowerCase().trim();
  if (s === 'running') return 'running';
  if (s === 'shut off' || s === 'shut_off') return 'stopped';
  if (s === 'paused') return 'paused';
  if (s === 'crashed') return 'crashed';
  return 'unknown';
}

// ─── Read-only queries ────────────────────────────────────────────────────────

export async function listVms(): Promise<VmSummary[]> {
  const out = await virsh(['list', '--all', '--uuid']);
  const lines = out.split('\n').filter(Boolean);
  const vms: VmSummary[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const id = parts[parts.length - 1];
    const name = parts[1];
    try {
      const info = await getVmInfo(name);
      vms.push({ id: info.id, name: info.name, status: info.status, cpus: info.cpus, memoryMb: info.memoryMb });
    } catch {
      vms.push({ id, name, status: 'unknown', cpus: 0, memoryMb: 0 });
    }
  }
  return vms;
}

/**
 * Every VM with the NICs it is defined with, running or not, as cheaply as that can be read.
 * Takes the networks its caller already holds: read again here, a failure would leave a NIC
 * under its libvirt name, and a guard comparing bridges would pass it.
 */
export async function listVmsWithNics(networks: readonly NetworkRef[]): Promise<Array<{ id: string; name: string; status: VmStatus; nics: VmNic[] }>> {
  const vms = await listDomains();
  const nics = await readNicsOf(vms.map((vm) => ({ id: vm.id, running: vm.status !== 'stopped' })), networks);
  return vms.map((vm, i) => ({ ...vm, nics: nics[i] }));
}

/**
 * The two listings `virsh list` gives, joined. The table has the state and the other the UUID, and
 * a name made outside VirtPilot can have spaces, even several, which is why neither is split on
 * them and why the name is what runs up to the last gap. A VM dropped here would pass the guard
 * on deleting its network, so a listing that doesn't add up throws. With no VMs, the second prints
 * nothing at all.
 */
export function parseDomainLists(table: string | null, names: string | null): Array<{ id: string; name: string; status: VmStatus }> {
  if (table === null) throw new Error('libvirt could not list its VMs');
  const lines = table.split('\n').slice(2).map((line) => line.trim()).filter(Boolean);
  const states = new Map(lines.flatMap((line) => {
    const m = line.match(/^\S+\s+(.+\S)\s{2,}(\S+(?: \S+)?)$/);
    return m ? [[m[1], m[2]]] : [];
  }));
  const rows = (names ?? '').split('\n').flatMap((line) => {
    const m = line.trim().match(/^(\S+)\s+(.+)$/);
    return m ? [{ id: m[1], name: m[2], status: parseStatus(states.get(m[2]) ?? '') }] : [];
  });
  if (rows.length !== lines.length) throw new Error('libvirt could not list its VMs');
  return rows;
}

async function listDomains(): Promise<Array<{ id: string; name: string; status: VmStatus }>> {
  const [table, names] = await virshBatch([['list', '--all'], ['list', '--all', '--uuid', '--name']]);
  return parseDomainLists(table, names);
}

export async function listVmsRaw(): Promise<VmSummary[]> {
  const domains = await listDomains();
  // `dominfo` holds all a row here needs. The rest of getVmInfo costs several processes a VM,
  // and this is on a five second timer.
  const infos = await virshBatch(domains.map((vm) => ['dominfo', vm.id]));
  // Nothing at all is libvirt not answering: an error keeps the list the browser has, where
  // rows with nothing in them would say every VM has no CPUs.
  if (domains.length > 0 && infos.every((info) => info === null)) throw new Error('libvirt did not answer');
  const vms: VmSummary[] = domains.map(({ id, name, status }, i) => {
    const info = infos[i];
    if (!info) return { id, name, status, cpus: 0, memoryMb: 0 };
    const { cpus, memoryMb, autostart } = parseDomInfo(info);
    return { id, name, status, cpus, memoryMb, autostart };
  });

  // Fan out guest-agent pings in parallel — only meaningful for running VMs.
  const runningVms = vms.filter((v) => v.status === 'running');
  if (runningVms.length > 0) {
    const results = await Promise.allSettled(
      runningVms.map((v) => checkGuestAgent(v.id).then((ok) => ({ id: v.id, ok }))),
    );
    const agentMap = new Map(
      results
        .filter((r): r is PromiseFulfilledResult<{ id: string; ok: boolean }> => r.status === 'fulfilled')
        .map((r) => [r.value.id, r.value.ok]),
    );
    for (const vm of vms) {
      if (vm.status === 'running') vm.guestAgent = agentMap.get(vm.id) ?? false;
    }
  }

  // Enrich with the source image (for client-side OS-logo derivation) and
  // recent CPU history (for roster sparklines). Best-effort: one metadata file
  // read + one metrics query for the whole list, so it stays cheap.
  try {
    const metas = await listVmMetas();
    const metaByUuid = new Map(metas.map((m) => [m.uuid, m]));
    const cpuByUuid = getRecentVmCpu();
    for (const vm of vms) {
      const filename = metaByUuid.get(vm.id)?.sourceTemplateFilename;
      if (filename) vm.sourceTemplateFilename = filename;
      const spark = cpuByUuid.get(vm.id);
      if (spark && spark.length) vm.cpuSpark = spark;
    }
  } catch { /* enrichment is best-effort — roster degrades gracefully */ }

  return vms;
}

function parseDomInfo(info: string): VmBasics {
  const lines = info.split('\n');
  const get = (key: string): string => {
    const line = lines.find((l) => l.startsWith(key));
    return line?.split(':')[1]?.trim() ?? '';
  };
  const memKb = parseInt(get('Used memory').replace(/[^0-9]/g, '') || '0', 10);
  return {
    id: get('UUID'),
    name: get('Name'),
    status: parseStatus(get('State')),
    cpus: parseInt(get('CPU(s)') || '0', 10),
    memoryMb: Math.round(memKb / 1024),
    autostart: get('Autostart').toLowerCase() === 'enable',
  };
}

type VmBasics = Pick<Vm, 'id' | 'name' | 'status' | 'cpus' | 'memoryMb' | 'autostart'>;

/**
 * What virsh prints for a VM it has no record of, on libvirt 10.0 and 11.3, and nothing else:
 * a connection that broke during the lookup prints the same line with its reason after it.
 */
export function saysNoSuchVm(stderr: string): boolean {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^error: (failed to get domain|Domain not found)/i.test(line));
}

export function isNoSuchVm(err: unknown): boolean {
  if (err instanceof NetworkError) return err.status === 404;
  return saysNoSuchVm(String((err as { stderr?: unknown })?.stderr ?? ''));
}

/**
 * What libvirt says of a VM, or null if it has no such VM. Anything else throws, and every guard
 * asking "is it there, is it running" has to use this: "libvirt can't say" read as "gone" waves a
 * restore or a disk move through on a running VM's disks.
 */
export async function findVm(nameOrId: string): Promise<VmBasics | null> {
  const name = validateVmName(nameOrId);
  try {
    return parseDomInfo(await virsh(['dominfo', name]));
  } catch (err) {
    if (isNoSuchVm(err)) return null;
    throw err;
  }
}

/**
 * No NICs: nothing here needs them but the VM's page, which asks with getVmNics, whose failure
 * means something different. Throws if the VM isn't there or libvirt can't say.
 */
export async function getVmInfo(nameOrId: string): Promise<Omit<Vm, 'nics'>> {
  const name = validateVmName(nameOrId);
  const { id, name: vmName, status, cpus, memoryMb, autostart } = parseDomInfo(await virsh(['dominfo', name]));

  const disks = await getVmDisks(name);

  try {
    const xml = await getVmXml(name);
    const bootMap = parseBootOrderFromXml(xml);
    const busMap = parseDiskBusesFromXml(xml);
    for (const disk of disks) {
      disk.bootOrder = bootMap.get(disk.target);
      disk.bus = busMap.get(disk.target) ?? disk.bus;
    }
  } catch {
    // non-fatal — boot order and bus display degrade gracefully
  }

  let vncDisplay: string | undefined;
  let vncPort: number | undefined;
  try {
    const vnc = await virsh(['vncdisplay', name]);
    vncDisplay = vnc.trim();
    const portMatch = vncDisplay.match(/:(\d+)/);
    if (portMatch) vncPort = 5900 + parseInt(portMatch[1], 10);
  } catch {
    // VNC not available (VM stopped)
  }

  const guestAgent = status === 'running' ? await checkGuestAgent(name) : undefined;

  return { id, name: vmName, status, cpus, memoryMb, disks, vncDisplay, vncPort, guestAgent, autostart };
}

export async function getVmDisks(nameOrId: string): Promise<VmDisk[]> {
  const name = validateVmName(nameOrId);
  try {
    const out = await virsh(['domblklist', name, '--details']);
    const lines = out.split('\n').slice(2).filter(Boolean);
    const disks: VmDisk[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      // Columns are Type Device Target Source: "Type" is the source kind (file,
      // block, network), not the bus. getVmInfo fills the bus in from the domain
      // XML; other callers never read it.
      const type = parts[1] as 'disk' | 'cdrom';
      const target = parts[2];
      const source = parts[3] === '-' ? '' : parts[3];
      disks.push({ target, source, type, bus: '' });
    }

    await Promise.all(
      disks.map(async (disk) => {
        try {
          const info = await virsh(['domblkinfo', name, disk.target]);
          const m = info.match(/Capacity:\s+(\d+)/);
          if (m) {
            const bytes = parseInt(m[1], 10);
            disk.sizeGb = Math.round((bytes / (1024 ** 3)) * 10) / 10;
          }
        } catch { /* non-fatal — size stays undefined */ }
      }),
    );

    // Annotate each disk with file-existence and (where known) storage dir.
    // Missing-file detection lets the UI flag VMs whose ISO/disk has been
    // moved, deleted, or is on a mount that's gone away — much louder than
    // "this VM won't start" coming back at next boot.
    //
    // The function may have been called with either a libvirt name OR a UUID
    // (every public API path that hits getVmInfo passes a UUID). `virsh
    // domuuid` only accepts the *name*, so calling it with a UUID would fail
    // silently and leave storageDir annotation empty. Detect a UUID-shaped
    // input directly and skip the virsh round-trip.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let uuid = '';
    if (UUID_RE.test(name)) {
      uuid = name.toLowerCase();
    } else {
      try {
        const dom = await virsh(['domuuid', name]);
        uuid = dom.trim().toLowerCase();
      } catch { /* unable to resolve uuid — fall back to no storage-dir labelling */ }
    }
    const diskLocByFilename = new Map<string, { storageDirId: string }>();
    if (uuid) {
      try {
        const locs = await storageDirService.listDiskLocationsForVm(uuid);
        for (const l of locs) diskLocByFilename.set(l.diskFilename, { storageDirId: l.storageDirId });
      } catch { /* ignore — DB may be unavailable */ }
    }
    await Promise.all(
      disks.map(async (disk) => {
        if (!disk.source) return;
        try {
          await fs.access(disk.source);
          disk.fileMissing = false;
        } catch {
          disk.fileMissing = true;
        }
        const filename = path.basename(disk.source);
        const loc = diskLocByFilename.get(filename);
        if (loc) {
          disk.storageDirId = loc.storageDirId;
          try {
            const dir = await storageDirService.getDir(loc.storageDirId);
            if (dir) disk.storageDirName = dir.name;
          } catch { /* ignore */ }
        }
      }),
    );

    return disks;
  } catch {
    return [];
  }
}

function parseDomIfList(out: string): VmNic[] {
  const nics: VmNic[] = [];
  for (const line of out.split('\n').slice(2).filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const target = parts[0];
    const type = parts[1];
    const source = parts[2];
    const model = parts[3];
    const mac = parts[4];
    nics.push({ mac, source, type, model, target });
  }
  return nics;
}

/**
 * A running VM has two definitions, and they can differ. `virsh attach-interface --config` saves
 * a NIC for its next start, which plain `domiflist` doesn't show, and with no flags it plugs one
 * in until then. virt-manager or `virsh edit` can leave a MAC on one network now and another
 * next time, which is two rows here. A NIC in either is on that network: take the network away
 * and the VM loses it now or can't start later. Sources must already be bridges, or the same NIC
 * could differ only in how it is written.
 */
export function mergeNicDefinitions(live: VmNic[], saved: VmNic[]): VmNic[] {
  const same = (a: VmNic, b: VmNic) => a.mac.toLowerCase() === b.mac.toLowerCase() && a.source === b.source;
  return [
    ...live.map((n): VmNic => {
      const copy = saved.find((s) => same(n, s));
      if (!copy) return { ...n, onlyIn: 'live' };
      return copy.type === n.type ? n : { ...n, savedType: copy.type };
    }),
    ...saved.filter((s) => !live.some((n) => same(n, s))).map((n): VmNic => ({ ...n, onlyIn: 'saved' })),
  ];
}

type NetworkRef = Pick<Network, 'bridge' | 'libvirtName'>;

// A failed read is said, never read as no NICs: that would pass the guard on deleting a network
// with a VM on it. A table with no NICs still has its heading and rule.
function nicTable(answer: string | null): VmNic[] | null {
  return answer && /^-+$/.test(answer.split('\n')[1]?.trim() ?? '') ? parseDomIfList(answer) : null;
}

/** A stopped VM has the one definition, so `running: false` saves asking twice. All in one process. */
async function readNicsOf(vms: ReadonlyArray<{ id: string; running: boolean }>, networks: readonly NetworkRef[]): Promise<VmNic[][]> {
  const answers = await virshBatch(vms.flatMap(({ id, running }) => [['domiflist', id], ...(running ? [['domiflist', id, '--inactive']] : [])]));
  let next = 0;
  const definitions = vms.map(({ id, running }) => {
    const live = nicTable(answers[next++]);
    const saved = running ? nicTable(answers[next++]) : null;
    if (!live || (running && !saved)) throw new Error(`libvirt could not list the NICs of ${id}`);
    return { live, saved };
  });
  return resolveNics(definitions, networks);
}

async function resolveNics(definitions: ReadonlyArray<{ live: VmNic[]; saved: VmNic[] | null }>, networks: readonly NetworkRef[]): Promise<VmNic[][]> {
  const refs = [...networks, ...await osBridgeOwners(definitions.flatMap(({ live, saved }) => [...live, ...(saved ?? [])]), networks)];
  return definitions.map(({ live, saved }) => {
    const now = withBridgeSources(live, refs);
    return saved ? mergeNicDefinitions(now, withBridgeSources(saved, refs)) : now;
  });
}

/**
 * A NIC made outside VirtPilot, with virsh or virt-manager, names the libvirt network where
 * VirtPilot's own name its bridge. Everything after this, the browser too, knows a network by
 * its bridge, so the difference is dealt with where NICs are read. `type` still says how the
 * NIC is attached, and a libvirt network VirtPilot doesn't know keeps its name. `bridge` as well
 * as `network`, as that is what a running VM says of a NIC on a libvirt network in bridge mode.
 */
export function withBridgeSources(nics: VmNic[], networks: readonly NetworkRef[]): VmNic[] {
  return nics.map((nic) => {
    const network = nic.type === 'network' || nic.type === 'bridge' ? networks.find((n) => n.libvirtName === nic.source) : undefined;
    return network ? { ...nic, source: network.bridge } : nic;
  });
}

/** Whether a NIC's source is on this host, as a device or a libvirt network, known to VirtPilot or not. */
export async function nicSourceExists(source: string): Promise<boolean> {
  if ((await listNetworks()).some((n) => n.bridge === source || n.libvirtName === source)) return true;
  if (!isBatchWord(source)) return true;
  if (await fs.access(`/sys/class/net/${source}`).then(() => true, () => false)) return true;
  // Only for what libvirt says it has no record of: if it can't say, this is no time to warn.
  return virsh(['net-info', source]).then(() => true, (err: { stderr?: unknown }) => !/Network not found/i.test(String(err?.stderr ?? '')));
}

/** Running VMs' NICs on a network, by MAC, and what those guests' agents say those NICs hold. */
export async function guestsOn(network: NetworkRef): Promise<{ owner: Map<string, string>; names: Map<string, string>; addresses: NicAddress[] }> {
  const owner = new Map<string, string>();
  const names = new Map<string, string>();
  const vms = (await listVmsWithNics([network])).filter((vm) => vm.status === 'running' && vm.nics.some((nic) => nic.source === network.bridge));
  for (const vm of vms) {
    names.set(vm.id, vm.name);
    for (const nic of vm.nics) {
      if (nic.source === network.bridge && nic.onlyIn !== 'saved') owner.set(nic.mac.toLowerCase(), vm.id);
    }
  }
  const answers = await virshBatch(vms.map((vm) => ['domifaddr', vm.id, '--source', 'agent']));
  return { owner, names, addresses: answers.flatMap((answer) => parseDomIfAddr(answer ?? '')).filter((a) => owner.has(a.mac)) };
}

/** The bridge `virsh net-info` names, which a network in macvtap mode doesn't have. */
export function parseNetInfoBridge(info: string): string | null {
  return info.match(/^Bridge:\s*(\S+)/m)?.[1] ?? null;
}

/**
 * An OS bridge VirtPilot has a record of can belong to a libvirt network it doesn't: virbr0 to
 * `default`, or br0 to a network in bridge mode on it. A NIC on that network by name is on that
 * bridge. Asked only with such a record to match, which most hosts don't have, and at worst a
 * NIC reads under its libvirt name: every network VirtPilot would refuse to delete is in the list.
 */
async function osBridgeOwners(nics: readonly VmNic[], networks: readonly NetworkRef[]): Promise<NetworkRef[]> {
  const osBridges = new Set(networks.filter((n) => !n.libvirtName).map((n) => n.bridge));
  if (osBridges.size === 0) return [];
  const known = new Set(networks.flatMap((n) => [n.libvirtName, n.bridge]));
  const named = [...new Set(nics.filter((n) => (n.type === 'network' || n.type === 'bridge') && !known.has(n.source)).map((n) => n.source))].filter(isBatchWord);
  // A real device is what a `bridge` NIC's source usually is. A network called the same would mislabel it.
  const present = await Promise.all(named.map((name) => fs.access(`/sys/class/net/${name}`).then(() => true, () => false)));
  const names = named.filter((_, i) => !present[i]);
  if (names.length === 0) return [];
  const infos = await virshBatch(names.map((name) => ['net-info', name])).catch(() => [] as Array<string | null>);
  return names.flatMap((libvirtName, i) => {
    const bridge = parseNetInfoBridge(infos[i] ?? '');
    return bridge && osBridges.has(bridge) ? [{ libvirtName, bridge }] : [];
  });
}

export async function getVmNics(nameOrId: string): Promise<VmNic[]> {
  const name = validateVmName(nameOrId);
  const [liveAnswer, savedAnswer, savedXml] = await virshBatch([['domiflist', name], ['domiflist', name, '--inactive'], ['dumpxml', name, '--inactive']]);
  const live = nicTable(liveAnswer);
  const saved = nicTable(savedAnswer);
  if (!live || !saved) {
    // A batch can't say why. Worth asking, as these two read very differently to whoever gets them.
    if ((await findVm(name).catch(() => undefined)) === null) throw new NetworkError(`There is no VM ${name}.`, 404);
    throw new Error(`libvirt could not list the NICs of ${name}`);
  }
  const [nics] = await resolveNics([{ live, saved }], await listNetworks());

  try {
    const savedLimits = parseNicBandwidthFromXml(savedXml ?? '');
    // A NIC only on the running VM isn't in the saved XML. Worth asking only for one of those.
    const liveLimits = nics.some((n) => n.onlyIn === 'live') ? parseNicBandwidthFromXml(await virsh(['dumpxml', name])) : savedLimits;
    for (const nic of nics) {
      const bw = (nic.onlyIn === 'live' ? liveLimits : savedLimits).get(nic.mac.toLowerCase());
      if (bw) {
        if (bw.inboundKbps !== undefined) nic.inboundKbps = bw.inboundKbps;
        if (bw.outboundKbps !== undefined) nic.outboundKbps = bw.outboundKbps;
      }
    }
  } catch {
    // bandwidth info is best-effort; ignore if dumpxml fails
  }

  return nics;
}

/** The NICs a domain's XML defines, in its order. Where a VM is built from that XML, this is what it must re-key, whatever libvirt says later. */
export function parseInterfacesFromXml(xml: string): Array<{ mac: string; model: string; source: string }> {
  return [...xml.matchAll(/<interface\b[^>]*>([\s\S]*?)<\/interface>/g)].flatMap(([, block]) => {
    const mac = block.match(/<mac\s+address=['"]([^'"]+)['"]/)?.[1];
    if (!mac) return [];
    const model = block.match(/<model\s+type=['"]([^'"]+)['"]/)?.[1] ?? '-';
    const source = block.match(/<source\s[^>]*\b(?:bridge|network|dev)=['"]([^'"]+)['"]/)?.[1] ?? '-';
    return [{ mac, model, source }];
  });
}

function parseNicBandwidthFromXml(xml: string): Map<string, { inboundKbps?: number; outboundKbps?: number }> {
  const result = new Map<string, { inboundKbps?: number; outboundKbps?: number }>();
  const ifaceRegex = /<interface\b[^>]*>([\s\S]*?)<\/interface>/g;
  let match;
  while ((match = ifaceRegex.exec(xml)) !== null) {
    const block = match[1];
    const macMatch = block.match(/<mac\s+address=['"]([^'"]+)['"]/);
    if (!macMatch) continue;
    const mac = macMatch[1].toLowerCase();
    const bwMatch = block.match(/<bandwidth\b[^>]*>([\s\S]*?)<\/bandwidth>/);
    if (!bwMatch) continue;
    const bw = bwMatch[1];
    const inbAvg = bw.match(/<inbound\b[^>]*\baverage=['"](\d+)['"]/);
    const outbAvg = bw.match(/<outbound\b[^>]*\baverage=['"](\d+)['"]/);
    result.set(mac, {
      inboundKbps: inbAvg ? parseInt(inbAvg[1], 10) : undefined,
      outboundKbps: outbAvg ? parseInt(outbAvg[1], 10) : undefined,
    });
  }
  return result;
}

/**
 * The address of each NIC, from whatever knows it. Sources fill in for each other
 * NIC by NIC: the host's ARP cache knows nothing about a VXLAN it never talks on,
 * while the network's own lease table does, and a bridge NIC never shows under
 * `--source lease`.
 */
export async function getVmInterfaceIps(nameOrId: string): Promise<Record<string, string>> {
  const name = validateVmName(nameOrId);
  const result: Record<string, string> = {};
  // The agent last, as the one that can stall, and a batch keeps what it had finished.
  const [arp, state, agent] = await virshBatch([
    ['domifaddr', name, '--source', 'arp'],
    ['domstate', name],
    ['domifaddr', name, '--source', 'agent'],
  ]).catch(() => [] as Array<string | null>);
  for (const answer of [agent, arp]) {
    for (const { mac, ip } of parseDomIfAddr(answer ?? '')) result[mac] ??= ip;
  }
  try {
    // A lease outlives a stopped VM by its whole lease time: an address it doesn't have.
    const running = parseStatus(state ?? '') !== 'stopped';
    // A NIC saved for its next start isn't connected, though an old lease may still name it.
    const missing = running ? (await getVmNics(name)).filter((nic) => nic.onlyIn !== 'saved' && !result[nic.mac.toLowerCase()]) : [];
    if (missing.length > 0) {
      for (const net of await listNetworks()) {
        if (!net.libvirtName || !missing.some((nic) => nic.source === net.bridge)) continue;
        const leases = parseDhcpLeases(await virsh(['net-dhcp-leases', net.libvirtName]).catch(() => ''));
        for (const nic of missing) {
          const ip = nic.source === net.bridge ? leases.get(nic.mac.toLowerCase()) : undefined;
          if (ip) result[nic.mac.toLowerCase()] = ip;
        }
      }
    }
  } catch { /* best-effort: the NIC shows as not resolved yet */ }
  return result;
}

/**
 * Best-effort resolution of a VM's primary IPv4 address.
 *
 * Deliberately consults libvirt's DHCP leases, not just ARP. A VM on a managed
 * NAT network has no static address recorded, so ARP was the only source — and
 * ARP entries expire. Applying a deny-all inbound firewall therefore starved
 * the very lookup the *next* firewall apply depends on, leaving the operator
 * unable to change the rules back. A lease is bookkeeping libvirt owns; it
 * survives the guest being unreachable.
 */
export async function resolveVmIp(nameOrId: string): Promise<string | null> {
  const id = validateVmName(nameOrId);

  // 1. A statically-allocated address is authoritative and free to read.
  let primaryMac: string | undefined;
  try {
    const metas = await listVmMetas();
    const meta = metas.find((m) => m.uuid === id.toLowerCase());
    const primary = meta?.networks?.find((n) => n.isPrimary);
    if (primary?.ip) return primary.ip;
    primaryMac = primary?.mac.toLowerCase();
  } catch { /* fall through */ }

  // A lease outlives a stopped VM by its whole lease time: an address it doesn't have.
  if (parseStatus(await virsh(['domstate', id]).catch(() => '')) === 'stopped') return null;

  // The primary NIC's address wins wherever it turns up. Until a source has it, any
  // other address is only held in reserve, for showing and for the SSH console. The
  // firewall needs a stricter answer: see resolveFirewallTarget.
  let reserve: string | null = null;
  const found = (addresses: NicAddress[]): string | null => {
    reserve ??= pickVmIp(addresses);
    return primaryMac ? addresses.find((a) => a.mac === primaryMac)?.ip ?? null : reserve;
  };

  // 2. Ask the guest, then the host's ARP cache.
  for (const source of ['agent', 'lease', 'arp'] as const) {
    try {
      const ip = found(parseDomIfAddr(await virsh(['domifaddr', id, '--source', source])));
      if (ip) return ip;
    } catch { /* try the next source */ }
  }

  // 3. The lease table of whichever managed network the VM's NICs sit on.
  //    `domifaddr --source lease` does not always find it; the per-network
  //    listing does.
  try {
    const nics = (await getVmNics(id)).filter((n) => n.onlyIn !== 'saved');
    const macs = nics.map((n) => n.mac.toLowerCase());
    const networks = await listNetworks();
    for (const net of networks) {
      if (!net.libvirtName || !nics.some((n) => n.source === net.bridge)) continue;
      const leases = parseDhcpLeases(await virsh(['net-dhcp-leases', net.libvirtName]).catch(() => ''));
      const addresses = macs.flatMap((mac) => {
        const ip = leases.get(mac);
        return ip ? [{ mac, ip }] : [];
      });
      const ip = found(addresses);
      if (ip) return ip;
    }
  } catch { /* give up */ }

  return reserve;
}

/**
 * The NIC VirtPilot's firewall filters: one whose traffic is routed through this host, the
 * primary one if it can be. Never a VXLAN's: its traffic goes straight through the bridge, so
 * rules there filter nothing, and the FORWARD jumps they need sit above libvirt's isolation
 * of the network, so they would let other networks in.
 */
async function findFirewallNic(id: string) {
  const [defined, networks, metas] = await Promise.all([getVmNics(id), listNetworks(), listVmMetas().catch(() => [])]);
  // A NIC saved for its next start has no traffic yet, and no address to filter.
  const nics = defined.filter((n) => n.onlyIn !== 'saved');
  const vxlanBridges = new Set(networks.filter((n) => n.type === 'vxlan').map((n) => n.bridge));
  const routed = nics.filter((n) => !vxlanBridges.has(n.source));
  const allocs = metas.find((m) => m.uuid === id.toLowerCase())?.networks ?? [];
  const primaryMac = allocs.find((a) => a.isPrimary)?.mac.toLowerCase();
  return {
    target: routed.find((n) => n.mac.toLowerCase() === primaryMac) ?? routed[0],
    vxlanOnly: nics.length > 0 && routed.length === 0,
    routedLater: defined.some((n) => !vxlanBridges.has(n.source)),
    allocs,
  };
}

export async function firewallNicMac(nameOrId: string): Promise<string | undefined> {
  return (await findFirewallNic(validateVmName(nameOrId))).target?.mac.toLowerCase();
}

/** The address VirtPilot's firewall filters: that of the NIC above. */
export async function resolveFirewallTarget(nameOrId: string): Promise<{ ip: string | null; vxlanOnly: boolean; routedLater?: boolean }> {
  const id = validateVmName(nameOrId);
  const { target, vxlanOnly, routedLater, allocs } = await findFirewallNic(id);
  if (vxlanOnly) return { ip: null, vxlanOnly: true, routedLater };
  if (!target) return { ip: null, vxlanOnly: false };
  const mac = target.mac.toLowerCase();
  const fixed = allocs.find((a) => a.mac.toLowerCase() === mac)?.ip;
  if (fixed) return { ip: fixed, vxlanOnly: false };
  const seen = (await getVmInterfaceIps(id))[mac] ?? null;
  // ARP knows a MAC whatever network it was on, and a firewall on that address filters whoever
  // has it now. The network's own lease knows better.
  const network = (await listNetworks()).find((n) => n.bridge === target.source);
  if (seen && network?.cidr && !ipInCidr(seen, network.cidr)) {
    const leases = network.libvirtName ? parseDhcpLeases(await virsh(['net-dhcp-leases', network.libvirtName]).catch(() => '')) : new Map<string, string>();
    return { ip: leases.get(mac) ?? null, vxlanOnly: false };
  }
  return { ip: seen, vxlanOnly: false };
}

// ─── Mutating operations ──────────────────────────────────────────────────────

// Sends a guest-ping via QEMU guest agent. Returns false if agent is absent or
// the VM is not running — intentionally swallows all errors.
async function checkGuestAgent(nameOrId: string): Promise<boolean> {
  try {
    const name = validateVmName(nameOrId);
    await virsh(['qemu-agent-command', name, '{"execute":"guest-ping"}', '--timeout', '3'], undefined, 5000);
    return true;
  } catch {
    return false;
  }
}

export async function startVm(nameOrId: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const trace: TraceEntry[] = [];
  await startDomain(name, trace);
  return formatTrace(trace);
}

/**
 * What libvirt says when a NIC's network isn't there, in words. A NIC on a bridge fails one way,
 * and a NIC attached by the network's name two others: stopped, or gone altogether.
 */
export function explainMissingNetwork(raw: string, networks: readonly NetworkRef[]): string | null {
  const m = raw.match(/Cannot get interface MTU on '([^']+)'|network '([^']+)' is not active|no network with matching name '([^']+)'/);
  if (!m) return null;
  const libvirtName = m[2] ?? m[3];
  const bridge = m[1] ?? networks.find((n) => n.libvirtName === libvirtName)?.bridge;
  if (bridge) return `This VM has a NIC on ${bridge}, and that network is not running on this host. Check it on the Networks page, or remove the NIC.`;
  // Not one of VirtPilot's, so the Networks page has nothing to say about it.
  return m[2]
    ? `This VM has a NIC on the libvirt network ${libvirtName}, which is not running. Start it with virsh net-start ${libvirtName}, or remove the NIC.`
    : `This VM has a NIC on the libvirt network ${libvirtName}, which no longer exists on this host. Remove the NIC on its Network tab.`;
}

/**
 * Every start VirtPilot makes goes through here.
 *
 * First the cached backing chain is dropped from the saved definition. libvirt
 * keeps one after a disk-only snapshot, one level deep (overlay, then
 * disk.qcow2), and on AppArmor hosts virt-aa-helper builds the guest's file
 * allowlist from that cache: the template underneath is left out and qemu
 * dies with "Permission denied" opening it. Without the cache libvirt reads
 * the chain from the images themselves.
 *
 * Then passthrough: anything VFIO would refuse is found first and said in
 * words, and a failure it still produces is translated where it is known.
 */
async function startDomain(name: string, trace: TraceEntry[]): Promise<void> {
  await refreshChainQuietly(name);
  await deviceService.checkBeforeStart(name);
  await getVmNics(name).then((nics) => ensureBridges(nics.map((n) => n.source))).catch(() => {});
  try {
    await virsh(['start', name], trace);
  } catch (err) {
    const why = await deviceService.explainStartFailure(err);
    if (why) throw new DeviceError(why, 409);
    const raw = String((err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : err));
    const missing = explainMissingNetwork(raw, await listNetworks());
    if (missing) throw new DeviceError(missing, 409);
    throw err;
  }
}

export async function stopVm(nameOrId: string, force = false): Promise<string> {
  const name = validateVmName(nameOrId);
  const trace: TraceEntry[] = [];
  if (force) {
    await virsh(['destroy', name], trace);
  } else {
    await virsh(['shutdown', name], trace);
  }
  return formatTrace(trace);
}

export async function rebootVm(nameOrId: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const trace: TraceEntry[] = [];
  await virsh(['reboot', name], trace);
  return formatTrace(trace);
}

export async function hardRebootVm(nameOrId: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const trace: TraceEntry[] = [];
  await virsh(['reset', name], trace);
  return formatTrace(trace);
}

export async function deleteVm(nameOrId: string, deleteStorage = false): Promise<string> {
  const name = validateVmName(nameOrId);
  const trace: TraceEntry[] = [];
  try { await virsh(['destroy', name], trace); } catch { /* already stopped */ }
  const flags = ['--snapshots-metadata', '--nvram', '--tpm'];
  if (deleteStorage) flags.push('--remove-all-storage');

  // Incremental backups leave checkpoints on the domain, and libvirt refuses to
  // undefine a domain that still has checkpoint metadata unless told to drop it
  // — most visibly on a "keep the storage" delete, where nothing else clears
  // them. The flag arrived in libvirt 5.6, so fall back for older hosts rather
  // than making delete fail outright there.
  try {
    await virsh(['undefine', name, ...flags, '--checkpoints-metadata'], trace);
  } catch (err) {
    if (!/unsupported option|unrecognized option|command 'undefine' doesn't support/i.test(String(err))) throw err;
    await virsh(['undefine', name, ...flags], trace);
  }
  return formatTrace(trace);
}

export async function defineVm(xmlPath: string, trace?: TraceEntry[]): Promise<void> {
  // xmlPath is always under config.cloudInitDir/config.storageRoot — never
  // user-controlled raw — but we still pass it as an array arg.
  await virsh(['define', xmlPath], trace);
}

export async function attachDisk(nameOrId: string, sourcePath: string, targetDev: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const target = validateDiskTarget(targetDev);
  const trace: TraceEntry[] = [];
  await virsh([
    'attach-disk', name,
    '--source', sourcePath,
    '--target', target,
    '--driver', 'qemu',
    '--subdriver', 'qcow2',
    '--persistent',
  ], trace);
  return formatTrace(trace);
}

export async function detachDisk(nameOrId: string, targetDev: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const target = validateDiskTarget(targetDev);
  const trace: TraceEntry[] = [];
  await virsh(['detach-disk', name, target, '--persistent'], trace);
  return formatTrace(trace);
}

// Build a regex matching a `<source ... file='oldPath' ...>` element. We match
// the whole opening tag (any attribute order) and capture the prefix up to
// `file=`, the opening quote, and the closing quote — the replacement swaps
// only the file value while preserving siblings like `index='2'`.
function sourceFileRegex(oldPath: string): RegExp {
  return new RegExp(
    `(<source\\b[^>]*?\\bfile=)(['"])${escapeRegex(oldPath)}(['"])`,
    'g',
  );
}

// Function-form replacement avoids `$&`/`$1`/`$$`/etc. interpolation that
// String.prototype.replace performs on a literal replacement string. Operator-
// supplied storage dir paths can legitimately contain `$` (e.g. `/mnt/My$Vol`)
// and a literal "$1" inside newPath would corrupt the rewrite.
function replaceFileAttr(newPath: string) {
  return (_match: string, before: string, openQuote: string, closeQuote: string): string =>
    `${before}${openQuote}${newPath}${closeQuote}`;
}

// Dry-run flavour for the move-disk flow's pre-flight check: returns the
// rewritten XML without applying it, so the caller can validate that the
// rewrite would succeed before touching the file on disk.
export async function buildReplacedDiskSourceXml(
  nameOrId: string,
  oldPath: string,
  newPath: string,
): Promise<string> {
  const name = validateVmName(nameOrId);
  const xml = await virsh(['dumpxml', name, '--inactive']);
  const re = sourceFileRegex(oldPath);
  if (!re.test(xml)) {
    throw new Error(`Disk source ${oldPath} not found in domain XML for ${name}`);
  }
  re.lastIndex = 0;
  return xml.replace(re, replaceFileAttr(newPath));
}

// Apply a pre-built domain XML via `virsh define`. Companion to
// buildReplacedDiskSourceXml so the route layer can validate the rewrite
// before touching the file, then commit afterwards.
export async function defineFromXml(xmlContent: string, nameForFilename = 'vm'): Promise<string> {
  const trace: TraceEntry[] = [];
  const tmp = path.join(os.tmpdir(), `virtpilot-define-${nameForFilename}-${Date.now()}.xml`);
  await fs.writeFile(tmp, xmlContent, 'utf8');
  try {
    await virsh(['define', tmp], trace);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  return formatTrace(trace);
}

// Rewrite a disk's `<source file='…'/>` in the persistent domain XML to point
// at a new absolute path. Used by the move-disk flow after the file has been
// physically relocated. VM must be stopped — libvirt rejects redefine of a
// running domain's storage path.
export async function replaceDiskSource(
  nameOrId: string,
  oldPath: string,
  newPath: string,
): Promise<string> {
  const updated = await buildReplacedDiskSourceXml(nameOrId, oldPath, newPath);
  return defineFromXml(updated, validateVmName(nameOrId));
}

export async function attachCdrom(nameOrId: string, isoPath: string, targetDev = 'sdb'): Promise<string> {
  const name = validateVmName(nameOrId);
  const target = validateDiskTarget(targetDev);
  const trace: TraceEntry[] = [];
  const state = await virsh(['domstate', name]);
  const flags = parseStatus(state) === 'running' ? ['--live', '--config'] : ['--config'];
  await virsh(['change-media', name, target, isoPath, ...flags], trace);
  return formatTrace(trace);
}

export async function detachCdrom(nameOrId: string, targetDev = 'sdb'): Promise<string> {
  const name = validateVmName(nameOrId);
  const target = validateDiskTarget(targetDev);
  const trace: TraceEntry[] = [];
  const state = await virsh(['domstate', name]);
  const flags = parseStatus(state) === 'running' ? ['--eject', '--live', '--config'] : ['--eject', '--config'];
  await virsh(['change-media', name, target, ...flags], trace);
  return formatTrace(trace);
}

export async function attachNic(
  nameOrId: string,
  bridge: string,
  model = 'virtio',
  mac?: string,
  bandwidth?: { inboundKbps?: number; outboundKbps?: number },
  mtu?: number,
): Promise<string> {
  const name = validateVmName(nameOrId);
  const br = validateBridgeName(bridge);
  // Shared with the domain-XML builder — keep the check in one place so the
  // two callers can't drift apart.
  const nicModel = validateNicModel(model);
  const trace: TraceEntry[] = [];
  // Before anything changes: a rate limit refused after the attach would leave a NIC
  // on the VM that the caller believes failed.
  const inboundKbps = validateNonNegativeInt(bandwidth?.inboundKbps ?? 0, 100_000_000);
  const outboundKbps = validateNonNegativeInt(bandwidth?.outboundKbps ?? 0, 100_000_000);
  if (mtu && mac) {
    // attach-interface has no way to say the MTU. The rate limit goes in with it, so the
    // NIC either arrives whole or not at all.
    const file = path.join(os.tmpdir(), `vp-nic-${randomUUID()}.xml`);
    await fs.writeFile(file, buildInterfaceXml({ bridge: br, mac: validateMac(mac), model: nicModel, mtu, inboundKbps, outboundKbps }), 'utf8');
    try {
      await virsh(['attach-device', name, file, '--persistent'], trace);
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  } else {
    const args = ['attach-interface', name, 'bridge', br, '--model', nicModel];
    if (mac) {
      const m = validateMac(mac);
      args.push('--mac', m);
    }
    args.push('--persistent');
    await virsh(args, trace);
    if (mac && (inboundKbps || outboundKbps)) {
      try {
        await setNicBandwidth(name, mac, { inboundKbps, outboundKbps }, trace);
      } catch (err) {
        // By what was just attached: reading the NICs may be what failed.
        await virsh(['detach-interface', name, 'bridge', '--mac', validateMac(mac), '--persistent'], trace).catch(() => {});
        throw err;
      }
    }
  }

  return formatTrace(trace);
}

export async function detachNic(nameOrId: string, mac: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const m = validateMac(mac);
  const trace: TraceEntry[] = [];
  // A NIC made outside VirtPilot may be of another type, and virsh wants the right one. It may
  // also be in only one of a running VM's definitions, where --persistent fails: on a saved one
  // after having removed it, on a live one with nothing done. A NIC called something else in
  // each definition, or on a different network in each, is taken from each in turn.
  const copies = (await getVmNics(name)).filter((n) => n.mac.toLowerCase() === m);
  const detach = (type: string | undefined, where: string) => virsh(['detach-interface', name, type ?? 'bridge', '--mac', m, where], trace);
  if (copies.length === 0) await detach('bridge', '--persistent');
  for (const nic of copies) {
    if (nic.savedType) {
      await detach(nic.savedType, '--config');
      await detach(nic.type, '--live');
    } else {
      await detach(nic.type, nic.onlyIn === 'saved' ? '--config' : nic.onlyIn === 'live' ? '--live' : '--persistent');
    }
  }
  return formatTrace(trace);
}

export async function setNicBandwidth(
  nameOrId: string,
  mac: string,
  bandwidth: { inboundKbps?: number; outboundKbps?: number },
  existingTrace?: TraceEntry[],
): Promise<string> {
  const name = validateVmName(nameOrId);
  const m = validateMac(mac);
  const inboundKbps = validateNonNegativeInt(bandwidth.inboundKbps ?? 0, 100_000_000);
  const outboundKbps = validateNonNegativeInt(bandwidth.outboundKbps ?? 0, 100_000_000);
  const trace = existingTrace ?? [];
  const state = await virsh(['domstate', name]);
  const status = parseStatus(state);
  const copies = (await getVmNics(name)).filter((n) => n.mac.toLowerCase() === m);
  // Not found counts as in both: libvirt says so if it isn't. A paused VM's NIC is as live as a running one's.
  const inLive = copies.length === 0 || copies.some((n) => n.onlyIn !== 'saved');
  const inSaved = copies.length === 0 || copies.some((n) => n.onlyIn !== 'live');
  const scope = [...((status === 'running' || status === 'paused') && inLive ? ['--live'] : []), ...(inSaved ? ['--config'] : [])];

  await virsh([
    'domiftune', name, m,
    '--inbound', String(inboundKbps),
    '--outbound', String(outboundKbps),
    ...scope,
  ], trace);
  return formatTrace(trace);
}

// ─── Boot Order ───────────────────────────────────────────────────────────────

export async function getVmXml(nameOrId: string): Promise<string> {
  const name = validateVmName(nameOrId);
  return virsh(['dumpxml', name, '--inactive']);
}

export function parseBootOrderFromXml(xml: string): Map<string, number> {
  const bootMap = new Map<string, number>();
  const diskRegex = /<disk\b[^>]*>([\s\S]*?)<\/disk>/g;
  let match;
  while ((match = diskRegex.exec(xml)) !== null) {
    const diskContent = match[1];
    const targetMatch = diskContent.match(/<target dev=['"]([^'"]+)['"]/);
    const bootMatch = diskContent.match(/<boot order=['"](\d+)['"]/);
    if (targetMatch && bootMatch) {
      bootMap.set(targetMatch[1], parseInt(bootMatch[1], 10));
    }
  }
  return bootMap;
}

// Each disk's bus (virtio, sata, scsi…) by target dev, from a domain's XML. Attribute
// order inside <target> varies between libvirt versions, so each is matched alone.
export function parseDiskBusesFromXml(xml: string): Map<string, string> {
  const buses = new Map<string, string>();
  const diskRegex = /<disk\b[^>]*>([\s\S]*?)<\/disk>/g;
  let match;
  while ((match = diskRegex.exec(xml)) !== null) {
    const target = match[1].match(/<target\b[^>]*>/)?.[0];
    if (!target) continue;
    const dev = target.match(/\bdev=['"]([^'"]+)['"]/)?.[1];
    const bus = target.match(/\bbus=['"]([^'"]+)['"]/)?.[1];
    if (dev && bus) buses.set(dev, bus);
  }
  return buses;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyBootOrderToXml(xml: string, bootOrder: string[]): string {
  let result = xml.replace(/<boot dev=['"][^'"]+['"]\s*\/>\n?\s*/g, '');
  result = result.replace(/\s*<boot order=['"]?\d+['"]?\s*\/>/g, '');
  for (let i = 0; i < bootOrder.length; i++) {
    const target = bootOrder[i];
    const order = i + 1;
    result = result.replace(
      new RegExp(`(<target dev=['"]${escapeRegex(target)}['"][^/]*/?>)`),
      `$1\n      <boot order="${order}"/>`
    );
  }
  return result;
}

async function setBootOrderInternal(nameOrId: string, bootOrder: string[], trace?: TraceEntry[]): Promise<void> {
  const name = validateVmName(nameOrId);
  for (const t of bootOrder) validateDiskTarget(t);
  const xml = await getVmXml(name);
  const newXml = applyBootOrderToXml(xml, bootOrder);
  const tmpPath = path.join(os.tmpdir(), `virtpilot-boot-${name}-${Date.now()}.xml`);
  await fs.writeFile(tmpPath, newXml, 'utf8');
  try {
    await virsh(['define', tmpPath], trace);
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export async function getBootOrder(nameOrId: string): Promise<string[]> {
  const xml = await getVmXml(nameOrId);
  const bootMap = parseBootOrderFromXml(xml);
  return [...bootMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([target]) => target);
}

export async function setBootOrder(nameOrId: string, bootOrder: string[]): Promise<string> {
  const trace: TraceEntry[] = [];
  await setBootOrderInternal(nameOrId, bootOrder, trace);
  return formatTrace(trace);
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

async function isUefiVm(nameOrId: string): Promise<boolean> {
  try {
    const xml = await virsh(['dumpxml', validateVmName(nameOrId)]);
    return /<loader\b[^>]*type=['"]pflash['"]/i.test(xml);
  } catch {
    return false;
  }
}

async function chooseExternalSnapshot(name: string): Promise<boolean> {
  if (await isUefiVm(name)) return true;
  const existing = await listSnapshots(name).catch(() => [] as VmSnapshot[]);
  const hasExternal = existing.some((s) => s.vmState === 'disk-snapshot');
  const hasInternal = existing.some((s) => s.vmState !== 'disk-snapshot');
  if (hasExternal) return true;
  const pci = await deviceService.hasPciPassthrough(name);
  if (!pci) return false;
  if (!hasInternal) return true;
  const running = parseStatus(await virsh(['domstate', name])) === 'running';
  if (running) {
    throw new DeviceError("This VM's snapshots are kept inside its disk, and libvirt can't take one of those while it runs " +
      'with a PCI device passed through. Shut the VM down to take a snapshot.', 409);
  }
  return false;
}

async function getSnapshotXml(nameOrId: string, snapshotName: string): Promise<string> {
  return virsh(['snapshot-dumpxml', validateVmName(nameOrId), validateSnapshotName(snapshotName)]);
}

function isExternalSnapshotXml(snapshotXml: string): boolean {
  return /snapshot=['"]external['"]/.test(snapshotXml);
}

function parseExternalSnapshotDisks(snapshotXml: string): { target: string; file: string }[] {
  const disks: { target: string; file: string }[] = [];
  const diskRegex = /<disk\b[^>]*\bname=['"]([^'"]+)['"][^>]*\bsnapshot=['"]external['"][^>]*>([\s\S]*?)<\/disk>/g;
  let m: RegExpExecArray | null;
  while ((m = diskRegex.exec(snapshotXml)) !== null) {
    const target = m[1];
    const fileMatch = m[2].match(/<source\s+file=['"]([^'"]+)['"]/);
    if (fileMatch) disks.push({ target, file: fileMatch[1] });
  }
  return disks;
}

function parseDiskSourceFromDomainXml(domainXml: string, target: string): string | undefined {
  const blockRegex = /<disk\b[^>]*>([\s\S]*?)<\/disk>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(domainXml)) !== null) {
    const block = m[1];
    if (!new RegExp(`<target\\s+dev=['"]${escapeRegex(target)}['"]`).test(block)) continue;
    const sourceMatch = block.match(/<source\s+file=['"]([^'"]+)['"]/);
    if (sourceMatch) return sourceMatch[1];
  }
  return undefined;
}

function extractSavedDomainXml(snapshotXml: string): string | undefined {
  const m = snapshotXml.match(/<domain\b[\s\S]*?<\/domain>/);
  return m ? m[0] : undefined;
}

export async function listSnapshots(nameOrId: string): Promise<VmSnapshot[]> {
  const name = validateVmName(nameOrId);
  try {
    const out = await virsh(['snapshot-list', name]);
    const lines = out.split('\n').slice(2).filter(Boolean);
    const snapshots: VmSnapshot[] = [];
    const lineRegex = /^\s*(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(\S+)\s*$/;
    for (const line of lines) {
      const match = line.match(lineRegex);
      if (!match) continue;
      const [, snapName, createdAt, vmState] = match;
      snapshots.push({ name: snapName, createdAt: new Date(createdAt).toISOString(), vmState });
    }

    if (snapshots.length > 0) {
      const vmDisks = await getVmDisks(name);
      await Promise.all(
        snapshots.map(async (snap) => {
          snap.sizeBytes = await getSnapshotSizeBytes(name, snap.name, vmDisks);
        }),
      );
    }

    return snapshots;
  } catch {
    return [];
  }
}

async function getSnapshotSizeBytes(
  nameOrId: string,
  snapshotName: string,
  vmDisks: VmDisk[],
): Promise<number> {
  try {
    const xml = await getSnapshotXml(nameOrId, snapshotName);
    if (isExternalSnapshotXml(xml)) {
      const disks = parseExternalSnapshotDisks(xml);
      let total = 0;
      await Promise.all(
        disks.map(async (d) => {
          try {
            const stat = await fs.stat(d.file);
            total += stat.size;
          } catch { /* overlay may already be committed away */ }
        }),
      );
      return total;
    }
    let total = 0;
    await Promise.all(
      vmDisks
        .filter((d) => d.type !== 'cdrom' && d.source)
        .map(async (d) => {
          try {
            const stdout = await qemuImg(['info', '--force-share', '--output=json', d.source]);
            const info = JSON.parse(stdout) as { snapshots?: Array<{ name: string; 'vm-state-size'?: number }> };
            const snap = info.snapshots?.find((s) => s.name === snapshotName);
            if (snap && typeof snap['vm-state-size'] === 'number') total += snap['vm-state-size'];
          } catch { /* skip */ }
        }),
    );
    return total;
  } catch {
    return 0;
  }
}

const SNAPSHOT_TIMEOUT = 3 * 60_000;

export async function fsFreeze(nameOrId: string): Promise<boolean> {
  try {
    await virsh(
      ['qemu-agent-command', validateVmName(nameOrId), '{"execute":"guest-fsfreeze-freeze"}', '--timeout', '5'],
      undefined,
      10_000,
    );
    return true;
  } catch {
    return false;
  }
}

export async function fsThaw(nameOrId: string): Promise<void> {
  try {
    await virsh(
      ['qemu-agent-command', validateVmName(nameOrId), '{"execute":"guest-fsfreeze-thaw"}', '--timeout', '5'],
      undefined,
      10_000,
    );
  } catch { /* best-effort */ }
}

export async function createSnapshot(nameOrId: string, snapshotName: string, description?: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const snap = validateSnapshotName(snapshotName);
  const trace: TraceEntry[] = [];
  // The description rides in the virsh argv, so it must be a plain single-line
  // string — anything else is rejected rather than escaped. It is passed with
  // the named `--description` flag below, which makes leading dashes harmless.
  if (description !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (typeof description !== 'string' || description.length > 512 || /[\x00-\x1f\x7f]/.test(description)) {
      throw new Error('Invalid snapshot description');
    }
  }
  // UEFI NVRAM rules out internal snapshots, and so does a running VM with a
  // PCI device passed through: libvirt saves its memory by migrating it to a
  // file, which VFIO refuses ("VFIO migration is not supported in kernel").
  // Those take a disk-only snapshot on external overlays. A VM never mixes the
  // two kinds: reverting an internal snapshot rewrites the very image an
  // external overlay stands on.
  const external = await chooseExternalSnapshot(name);

  // libvirt blocks every block operation on a disk carrying a dirty bitmap, so
  // a VM with backup checkpoints cannot be snapshotted. Say so plainly instead
  // of surfacing "Operation not supported: cannot perform block operations
  // while checkpoint exists" from virsh.
  const checkpoints = await virsh(['checkpoint-list', name, '--name']).catch(() => '');
  if (checkpoints.trim()) {
    throw new Error(
      'This VM has incremental-backup checkpoints, and libvirt will not allow snapshots while any exist. ' +
      'Delete this VM\'s backups (or switch its backup schedule to full backups) and try again.',
    );
  }

  const frozen = await fsFreeze(name);

  // Overlay ownership is the whole game here.
  //
  // When libvirt creates the overlay itself for a *running* domain, dynamic
  // ownership labels it for the qemu user and everything downstream works. For
  // a **stopped** domain there is no qemu process to label for, so the file
  // keeps libvirt's own `root:root 0600` — and the service account cannot
  // chmod what it does not own. Committing that snapshot away later runs
  // `qemu-img commit` as libvirt-qemu and dies with "Permission denied",
  // leaving a snapshot that can never be deleted and a VM permanently running
  // off the overlay.
  //
  // So create the overlays ourselves at 0660 and hand them to libvirt with
  // `--reuse-external`. libvirt-qemu is in the `virtpilot` group, so both ends
  // of every later qcow2-chain operation can read and write them.
  const overlayPaths: string[] = [];

  try {
    if (external) {
      const disks = await getVmDisks(name);
      const persistent = disks.filter((d) => d.type === 'disk' && d.source && /\.qcow2$/i.test(d.source));
      if (persistent.length === 0) {
        throw new Error('No qcow2 disks found to snapshot');
      }
      const args = ['snapshot-create-as', name, snap];
      if (description) args.push('--description', description);
      args.push('--disk-only', '--atomic', '--reuse-external');
      for (const d of persistent) {
        const dir = path.dirname(d.source);
        const overlay = path.join(dir, `${name}-${d.target}-${snap}.qcow2`);
        await fs.unlink(overlay).catch(() => { /* no leftover from a failed attempt */ });
        await run('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', d.source, overlay], { timeout: 60_000, trace });
        await fs.chmod(overlay, 0o660).catch(() => { /* best-effort */ });
        args.push('--diskspec', `${d.target},file=${overlay},snapshot=external`);
        overlayPaths.push(overlay);
      }
      for (const d of disks) {
        if (!persistent.find((p) => p.target === d.target)) {
          args.push('--diskspec', `${d.target},snapshot=no`);
        }
      }
      await virsh(args, trace, SNAPSHOT_TIMEOUT);
    } else {
      const args = ['snapshot-create-as', name, snap];
      if (description) args.push('--description', description);
      args.push('--atomic');
      await virsh(args, trace, SNAPSHOT_TIMEOUT);
    }
  } catch (err) {
    // A failed snapshot must not leave the overlays we pre-created lying around
    // — a later attempt with the same name would then find them and reuse a
    // stale image.
    for (const overlay of overlayPaths) await fs.unlink(overlay).catch(() => {});
    throw err;
  } finally {
    if (frozen) await fsThaw(name);
  }

  // Re-assert the mode: libvirt may have relabelled the overlay while starting
  // to use it. Best-effort — if it re-chowned the file we no longer own it,
  // but in that case it belongs to the qemu user and is already usable.
  for (const overlay of overlayPaths) {
    await fs.chmod(overlay, 0o660).catch(() => { /* file may have been re-chowned by libvirt */ });
  }
  // The snapshot leaves a backing-chain cache in the saved definition; see
  // startDomain for why that stops the next boot.
  if (external) await refreshChainQuietly(name);

  return formatTrace(trace);
}

export async function deleteSnapshot(
  nameOrId: string,
  snapshotName: string,
  opts: { metadataOnly?: boolean } = {},
): Promise<string> {
  const name = validateVmName(nameOrId);
  const snap = validateSnapshotName(snapshotName);
  const trace: TraceEntry[] = [];
  const snapshotXml = await getSnapshotXml(name, snap);

  if (opts.metadataOnly) {
    await virsh(['snapshot-delete', name, snap, '--metadata'], trace, SNAPSHOT_TIMEOUT);
    return formatTrace(trace);
  }

  if (!isExternalSnapshotXml(snapshotXml)) {
    await virsh(['snapshot-delete', name, snap], trace, SNAPSHOT_TIMEOUT);
    return formatTrace(trace);
  }

  const snapDisks = parseExternalSnapshotDisks(snapshotXml);
  if (snapDisks.length === 0) throw new Error('Snapshot XML has no external disk entries');

  const liveDisks = await getVmDisks(name);
  for (const sd of snapDisks) {
    const live = liveDisks.find((d) => d.target === sd.target);
    if (!live?.source) {
      throw new Error(`Disk ${sd.target} not present on VM`);
    }
    if (path.resolve(live.source) !== path.resolve(sd.file)) {
      const liveBase = path.basename(live.source);
      if (/-revert-\d+\.qcow2$/.test(liveBase)) {
        throw new Error(
          `Cannot delete snapshot '${snap}': the VM was reverted to it, ` +
            `so the active disk is now the revert overlay (${liveBase}). ` +
            `Use ?metadataOnly=true to drop the snapshot record while leaving the disk chain intact, ` +
            `or take a new snapshot and use that as your working state instead.`,
        );
      }
      throw new Error(
        `Cannot delete snapshot '${snap}': overlay for ${sd.target} is no longer the active disk (a newer snapshot exists). Delete newer snapshots first.`,
      );
    }
  }

  const stateOut = await virsh(['domstate', name]);
  const running = parseStatus(stateOut) === 'running';
  const overlayFiles: string[] = [];

  for (const sd of snapDisks) {
    overlayFiles.push(sd.file);
    // Defensive chmod 0660 — the overlay is owned virtpilot:virtpilot 0600 by
    // default, which blocks libvirt-qemu (running qemu-img via sudo) from
    // reading. Group-readable + libvirt-qemu being in the virtpilot group
    // gives it the access it needs.
    await fs.chmod(sd.file, 0o660).catch(() => { /* file may not exist or already correct */ });
    if (running) {
      const chainJson = await qemuImg(['info', '--force-share', '--output=json', '--backing-chain', sd.file]);
      const chain = JSON.parse(chainJson) as Array<{ filename: string; 'backing-filename'?: string }>;
      const backing = chain[0]?.['backing-filename'];
      if (!backing) throw new Error(`Could not determine backing file for ${sd.file}`);
      const backingAbs = path.isAbsolute(backing) ? backing : path.resolve(path.dirname(sd.file), backing);
      await virsh(
        ['blockcommit', name, sd.target, '--active', '--pivot', '--wait', '--verbose', '--top', sd.file, '--base', backingAbs],
        trace,
        SNAPSHOT_TIMEOUT,
      );
    } else {
      await qemuImg(['commit', '-d', sd.file], { timeout: SNAPSHOT_TIMEOUT, trace });
      const stdout = await qemuImg(['info', '--output=json', '--backing-chain', sd.file]);
      const chain = JSON.parse(stdout) as Array<{ filename: string; 'backing-filename'?: string }>;
      const backing = chain[0]?.['backing-filename'];
      if (!backing) throw new Error(`Could not determine backing file for ${sd.file}`);
      const backingAbs = path.isAbsolute(backing) ? backing : path.resolve(path.dirname(sd.file), backing);
      const domXml = await getVmXml(name);
      const updated = domXml.replace(
        new RegExp(`(<source\\s+file=['"])${escapeRegex(sd.file)}(['"])`),
        `$1${backingAbs}$2`,
      );
      if (updated === domXml) {
        throw new Error(`Failed to rewrite domain XML for ${sd.target}`);
      }
      const tmp = path.join(os.tmpdir(), `virtpilot-snapdel-${name}-${Date.now()}.xml`);
      await fs.writeFile(tmp, updated, 'utf8');
      try {
        await virsh(['define', tmp], trace);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
  }

  await virsh(['snapshot-delete', name, snap, '--metadata'], trace, SNAPSHOT_TIMEOUT);

  for (const f of overlayFiles) {
    await fs.unlink(f).catch(() => { /* best-effort */ });
  }
  await refreshChainQuietly(name);

  return formatTrace(trace);
}

export async function revertSnapshot(nameOrId: string, snapshotName: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const snap = validateSnapshotName(snapshotName);
  const trace: TraceEntry[] = [];
  const snapshotXml = await getSnapshotXml(name, snap);
  // Passed-through devices are the host's hardware, not the VM's state: a
  // snapshot from before a GPU was attached must not take it away, and one
  // from before it moved to another VM must not hand it back.
  const devicesBefore = parseHostdevs(await getVmXml(name));

  try { await virsh(['destroy', name], trace); } catch { /* already stopped */ }

  if (!isExternalSnapshotXml(snapshotXml)) {
    await virsh(['snapshot-revert', name, snap, '--force'], trace, SNAPSHOT_TIMEOUT);
  } else {
    const savedXml = extractSavedDomainXml(snapshotXml);
    if (!savedXml) throw new Error('Snapshot XML missing saved <domain> element');

    const snapDisks = parseExternalSnapshotDisks(snapshotXml);
    let pivotedXml = savedXml;
    const stamp = Date.now();
    for (const sd of snapDisks) {
      const sealed = parseDiskSourceFromDomainXml(savedXml, sd.target);
      if (!sealed) continue;
      const dir = path.dirname(sealed);
      const overlay = path.join(dir, `${name}-${sd.target}-revert-${stamp}.qcow2`);
      // Make the sealed backing file readable by libvirt-qemu (group)
      // before we ask it to read from it via qemu-img create -b.
      await fs.chmod(sealed, 0o660).catch(() => { /* may not need it */ });
      await qemuImg(['create', '-f', 'qcow2', '-F', 'qcow2', '-b', sealed, overlay], { timeout: 60_000, trace });
      // The new revert overlay will become the active disk on next start;
      // bump to 0660 so subsequent qemu-img calls (commit/info/resize) work.
      await fs.chmod(overlay, 0o660).catch(() => { /* ignore */ });
      pivotedXml = pivotedXml.replace(
        new RegExp(`(<source\\s+file=['"])${escapeRegex(sealed)}(['"])`),
        `$1${overlay}$2`,
      );
    }

    const tmp = path.join(os.tmpdir(), `virtpilot-revert-${name}-${stamp}.xml`);
    await fs.writeFile(tmp, pivotedXml, 'utf8');
    try {
      await virsh(['define', tmp], trace);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  await keepDevices(name, devicesBefore, trace).catch((err: unknown) => {
    // The revert itself has happened; a VM started with the snapshot's devices is
    // still checked against the host before it starts.
    trace.push({ cmd: 'virsh define (restoring the passed-through devices)', stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 });
  });
  await refreshChainQuietly(name);

  const state = await virsh(['domstate', name]);
  if (parseStatus(state) !== 'running') {
    await startDomain(name, trace);
  }
  return formatTrace(trace);
}

/** Put a VM's saved definition back to exactly these passed-through devices. */
async function keepDevices(name: string, devices: ReturnType<typeof parseHostdevs>, trace: TraceEntry[]): Promise<void> {
  const xml = await getVmXml(name);
  const now = parseHostdevs(xml).map((h) => h.xml).join('\n');
  const wanted = devices.map((h) => h.xml).join('\n');
  if (now === wanted) return;
  const { xml: bare } = stripHostdevs(xml);
  // Without their old guest slots: the snapshot's definition may have something else there.
  const portable = devices.map((h) => portableHostdevXml(h.xml)).join('\n');
  const withDevices = portable ? bare.replace(/<\/devices>/, `${portable}\n  </devices>`) : bare;
  const out = await defineFromXml(withDevices, name);
  trace.push({ cmd: 'virsh define (restoring the passed-through devices)', stdout: out, stderr: '', exitCode: 0 });
}

export async function exportSnapshotAsTemplate(vmName: string, snapshotName: string, destPath: string): Promise<string> {
  const name = validateVmName(vmName);
  const snap = validateSnapshotName(snapshotName);
  // destPath comes from the route layer (resolved via storageDirService); we
  // re-validate the filename portion as defence-in-depth.
  const safeFilename = path.basename(destPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(qcow2|img|raw)$/i.test(safeFilename)) {
    throw new Error('Invalid template filename');
  }
  const trace: TraceEntry[] = [];
  const snapshotXml = await getSnapshotXml(name, snap);

  if (isExternalSnapshotXml(snapshotXml)) {
    const savedXml = extractSavedDomainXml(snapshotXml);
    if (!savedXml) throw new Error('Snapshot XML missing saved <domain> element');
    const sealed = parseDiskSourceFromDomainXml(savedXml, 'vda');
    if (!sealed) throw new Error('Snapshot does not include vda');
    await qemuImg(
      ['convert', '-U', '-f', 'qcow2', '-O', 'qcow2', sealed, destPath],
      { timeout: 300_000, trace },
    );
  } else {
    const disks = await getVmDisks(name);
    const primaryDisk = disks.find((d) => d.target === 'vda' && d.source);
    if (!primaryDisk?.source) throw new Error('Primary disk (vda) not found or has no source path');
    await qemuImg(
      ['convert', '-U', '-f', 'qcow2', '-O', 'qcow2', '-l', `snapshot.name=${snap}`, primaryDisk.source, destPath],
      { timeout: 300_000, trace },
    );
  }
  return formatTrace(trace);
}

/**
 * Drops libvirt's cached view of each disk's backing chain and re-defines the
 * domain, so the chain is re-probed from the images on next start.
 *
 * libvirt records the chain it found in `<backingStore>` elements inside the
 * persistent XML. Anything that replaces an image out-of-band — a restore, a
 * disk swapped by hand — leaves that cache describing a chain the file no
 * longer has. The consequences are not subtle: a stale entry pointing at
 * another disk on the same VM makes qemu open that file twice and refuse to
 * start the domain at all with `Failed to get "write" lock`.
 */
export async function refreshDomainBackingChain(nameOrId: string): Promise<void> {
  const name = validateVmName(nameOrId);
  const xml = await virsh(['dumpxml', name, '--inactive']);
  // Both forms: <backingStore/> (explicitly "no backing") and the container
  // form holding the cached chain, nested one level per overlay.
  const stripped = stripBackingStores(xml);
  if (stripped === xml) return;
  await defineFromXml(stripped, name);
}

/** The chain refresh where a failure must not stop what follows, but must not vanish either. */
async function refreshChainQuietly(name: string): Promise<void> {
  await refreshDomainBackingChain(name).catch((err: unknown) => {
    console.warn(`[vm] could not drop the cached disk chain of ${name}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// ─── Transient backup snapshots ───────────────────────────────────────────────

// Used to obtain a *static* copy of a running VM's disks without stalling the
// guest for the duration of the copy. The domain is pivoted onto a throwaway
// overlay (milliseconds, optionally quiesced), the now-frozen base files are
// copied at leisure, then the overlay is committed back and deleted.
//
// This is the fallback for hosts whose libvirt/qemu lack push-mode backup
// support; where `libvirtBackupService.isBackupSupported()` is true, that path
// is better still — qemu does copy-before-write internally with no overlay to
// commit, and it can produce incrementals.

const BACKUP_COMMIT_TIMEOUT = 60 * 60_000;

export interface TransientSnapshotDisk {
  target: string;
  /** The image the domain was using before the snapshot — static while the overlay is live. */
  base: string;
  /** The overlay the domain writes to until the snapshot is committed. */
  overlay: string;
}

export interface TransientSnapshotResult {
  name: string;
  disks: TransientSnapshotDisk[];
  /** True when the guest agent froze filesystems as part of taking the snapshot. */
  quiesced: boolean;
}

export async function createTransientDiskSnapshot(
  nameOrId: string,
  snapshotName: string,
  trace?: TraceEntry[],
): Promise<TransientSnapshotResult> {
  const name = validateVmName(nameOrId);
  const snap = validateSnapshotName(snapshotName);

  const allDisks = await getVmDisks(name);
  const persistent = allDisks.filter((d) => d.type === 'disk' && d.source && /\.qcow2$/i.test(d.source));
  if (persistent.length === 0) throw new Error('No qcow2 disks found to snapshot');

  const planned: TransientSnapshotDisk[] = persistent.map((d) => ({
    target: d.target,
    base: d.source,
    overlay: path.join(path.dirname(d.source), `${name}-${d.target}-${snap}.qcow2`),
  }));

  const buildArgs = (quiesce: boolean): string[] => {
    // --no-metadata: this snapshot is an implementation detail of the copy, not
    // something the operator should find (or be able to revert to) in the
    // snapshot list. The `-vpbk-` marker in the overlay filename is what
    // identifies it if the process dies between snapshot and commit.
    const args = ['snapshot-create-as', name, snap, '--disk-only', '--atomic', '--no-metadata'];
    if (quiesce) args.push('--quiesce');
    for (const d of planned) {
      args.push('--diskspec', `${d.target},file=${d.overlay},snapshot=external`);
    }
    for (const d of allDisks) {
      if (!planned.find((p) => p.target === d.target)) args.push('--diskspec', `${d.target},snapshot=no`);
    }
    return args;
  };

  // Quiescing needs a live guest agent. Attempt it, but a guest without the
  // agent must still get a (crash-consistent) copy rather than an error.
  let quiesced = false;
  const agentUp = await checkGuestAgent(name);
  if (agentUp) {
    try {
      await virsh(buildArgs(true), trace, SNAPSHOT_TIMEOUT);
      quiesced = true;
    } catch {
      quiesced = false;
    }
  }
  if (!quiesced) {
    await virsh(buildArgs(false), trace, SNAPSHOT_TIMEOUT);
  }

  // External overlays land virtpilot:virtpilot 0600, which blocks libvirt-qemu
  // (running qemu-img via sudo) from reading them during the later commit.
  for (const d of planned) {
    await fs.chmod(d.overlay, 0o660).catch(() => { /* libvirt may have re-chowned it already */ });
  }

  return { name: snap, disks: planned, quiesced };
}

/**
 * Folds each transient overlay back into its base and points the domain at the
 * base again, then removes the overlay. Safe to call whether or not the VM is
 * still running — a guest that shut down mid-copy takes the offline path.
 */
export async function commitTransientDiskSnapshot(
  nameOrId: string,
  snapshot: TransientSnapshotResult,
  trace?: TraceEntry[],
): Promise<void> {
  const name = validateVmName(nameOrId);
  const stateOut = await virsh(['domstate', name]);
  const running = parseStatus(stateOut) === 'running';

  for (const d of snapshot.disks) {
    // An overlay that never materialised (snapshot half-failed) has nothing to
    // commit; skip it rather than failing the whole cleanup.
    try {
      await fs.access(d.overlay);
    } catch {
      continue;
    }

    if (running) {
      await virsh(
        ['blockcommit', name, d.target, '--active', '--pivot', '--wait', '--verbose', '--top', d.overlay, '--base', d.base],
        trace,
        BACKUP_COMMIT_TIMEOUT,
      );
    } else {
      await qemuImg(['commit', '-d', d.overlay], { timeout: BACKUP_COMMIT_TIMEOUT, trace });
      const domXml = await getVmXml(name);
      const updated = domXml.replace(sourceFileRegex(d.overlay), replaceFileAttr(d.base));
      if (updated === domXml) {
        throw new Error(`Failed to point ${d.target} back at ${d.base} after committing the backup overlay`);
      }
      await defineFromXml(updated, name);
    }

    await fs.unlink(d.overlay).catch(() => { /* blockcommit --pivot may have removed it */ });
  }
  // The overlay is gone, but the saved definition may still cache a chain
  // through it; see startDomain.
  await refreshChainQuietly(name);
}

// ─── Autostart ────────────────────────────────────────────────────────────────

export async function setAutostart(nameOrId: string, enabled: boolean): Promise<string> {
  const name = validateVmName(nameOrId);
  const trace: TraceEntry[] = [];
  await virsh(enabled ? ['autostart', name] : ['autostart', '--disable', name], trace);
  return formatTrace(trace);
}

// ─── Disk resize ──────────────────────────────────────────────────────────────

export async function resizeDisk(nameOrId: string, target: string, addGb: number): Promise<string> {
  const name = validateVmName(nameOrId);
  const tgt = validateDiskTarget(target);
  if (!Number.isFinite(addGb) || addGb <= 0 || addGb > 65536) throw new Error('Invalid resize amount');
  const trace: TraceEntry[] = [];

  const disks = await getVmDisks(name);
  const disk = disks.find((d) => d.target === tgt);
  if (!disk?.source) throw new Error(`Disk ${tgt} not found or has no source path`);

  // The active disk may be a snapshot overlay (virtpilot:virtpilot 0600) that
  // blocks libvirt-qemu reads. Bump to 0660 so qemuImg (running as
  // libvirt-qemu via sudo, which is in the virtpilot group) can read+write.
  await fs.chmod(disk.source, 0o660).catch(() => { /* may already be correct or owned differently */ });

  const state = await virsh(['domstate', name]);
  const running = parseStatus(state) === 'running';

  if (running) {
    const stdout = await qemuImg(['info', '-U', '--output=json', disk.source]);
    const info = JSON.parse(stdout) as { 'virtual-size': number };
    const newSizeBytes = info['virtual-size'] + addGb * 1024 * 1024 * 1024;
    await virsh(['blockresize', name, tgt, `${newSizeBytes}b`], trace);
  } else {
    await qemuImg(['resize', disk.source, `+${addGb}G`], { timeout: 120_000, trace });
  }

  return formatTrace(trace);
}

// ─── Resource editing (CPU + RAM) ─────────────────────────────────────────────

export async function updateVmResources(nameOrId: string, cpus: number, memoryMb: number): Promise<string> {
  const name = validateVmName(nameOrId);
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 1024) throw new Error('Invalid CPU count');
  if (!Number.isInteger(memoryMb) || memoryMb < 64 || memoryMb > 8 * 1024 * 1024) throw new Error('Invalid memory size');
  const trace: TraceEntry[] = [];
  const xml = await getVmXml(name);
  const memKib = memoryMb * 1024;

  const newXml = xml
    .replace(/<vcpu[^>]*>[0-9]+<\/vcpu>/, `<vcpu placement="static">${cpus}</vcpu>`)
    .replace(/<memory unit=['"]KiB['"]>[0-9]+<\/memory>/, `<memory unit="KiB">${memKib}</memory>`)
    .replace(/<currentMemory unit=['"]KiB['"]>[0-9]+<\/currentMemory>/, `<currentMemory unit="KiB">${memKib}</currentMemory>`);

  const tmpPath = path.join(os.tmpdir(), `virtpilot-res-${name}-${Date.now()}.xml`);
  await fs.writeFile(tmpPath, newXml, 'utf8');
  try {
    await virsh(['define', tmpPath], trace);
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
  return formatTrace(trace);
}

// ─── Per-VM metrics ───────────────────────────────────────────────────────────

const vmStatsPrev = new Map<string, {
  timestamp: number;
  cpuTimeNs: number;
  blockRdBytes: number;
  blockWrBytes: number;
  netRxBytes: number;
  netTxBytes: number;
}>();
const vmStatsHistory = new Map<string, VmStatsSample[]>();
const VM_STATS_HISTORY = 30;

function parseDomStats(out: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*([a-z0-9_.]+)=(\d+)\s*$/);
    if (m) result.set(m[1], parseInt(m[2], 10));
  }
  return result;
}

export async function getVmStats(nameOrId: string): Promise<VmStatsResponse | null> {
  const name = validateVmName(nameOrId);
  try {
    const out = await virsh(['domstats', name], undefined, 10_000);
    const s = parseDomStats(out);

    const get = (k: string) => s.get(k) ?? 0;
    const cpuTimeNs = get('cpu.time');
    const vcpuCount = get('vcpu.current') || get('vcpu.maximum') || 1;
    const mem = guestMemory(s);

    const blockCount = get('block.count');
    let blockRdBytes = 0;
    let blockWrBytes = 0;
    for (let i = 0; i < blockCount; i++) {
      blockRdBytes += get(`block.${i}.rd.bytes`);
      blockWrBytes += get(`block.${i}.wr.bytes`);
    }

    const netCount = get('net.count');
    let netRxBytes = 0;
    let netTxBytes = 0;
    for (let i = 0; i < netCount; i++) {
      netRxBytes += get(`net.${i}.rx.bytes`);
      netTxBytes += get(`net.${i}.tx.bytes`);
    }

    const now = Date.now();
    const prev = vmStatsPrev.get(name);
    vmStatsPrev.set(name, { timestamp: now, cpuTimeNs, blockRdBytes, blockWrBytes, netRxBytes, netTxBytes });

    let cpuPercent = 0;
    let diskReadBps = 0;
    let diskWriteBps = 0;
    let netRxBps = 0;
    let netTxBps = 0;

    if (prev) {
      const dt = (now - prev.timestamp) / 1000;
      if (dt > 0) {
        const maxCpuNs = dt * vcpuCount * 1e9;
        cpuPercent = Math.min(100, Math.max(0, ((cpuTimeNs - prev.cpuTimeNs) / maxCpuNs) * 100));
        diskReadBps = Math.max(0, (blockRdBytes - prev.blockRdBytes) / dt);
        diskWriteBps = Math.max(0, (blockWrBytes - prev.blockWrBytes) / dt);
        netRxBps = Math.max(0, (netRxBytes - prev.netRxBytes) / dt);
        netTxBps = Math.max(0, (netTxBytes - prev.netTxBytes) / dt);
      }
    }

    const sample: VmStatsSample = {
      timestamp: now,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memUsedMb: mem.usedMb,
      memTotalMb: mem.totalMb,
      memSource: mem.source,
      diskReadBps,
      diskWriteBps,
      netRxBps,
      netTxBps,
      vcpuCount,
    };

    const hist = vmStatsHistory.get(name) ?? [];
    hist.push(sample);
    if (hist.length > VM_STATS_HISTORY) hist.shift();
    vmStatsHistory.set(name, hist);

    return { current: sample, history: [...hist] };
  } catch {
    return null;
  }
}

export async function startVmBootOnce(nameOrId: string, device: 'cdrom' | 'hd'): Promise<string> {
  const name = validateVmName(nameOrId);
  const trace: TraceEntry[] = [];

  const xml = await getVmXml(name);
  const bootMap = parseBootOrderFromXml(xml);
  const originalOrder = [...bootMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([t]) => t);

  const diskList = await getVmDisks(name);
  const deviceTargets = diskList.filter((d) => d.type === device).map((d) => d.target);
  const otherTargets = diskList.filter((d) => d.type !== device).map((d) => d.target);
  const onceOrder = [...deviceTargets, ...otherTargets].filter((t) => t !== 'sda');

  await setBootOrderInternal(name, onceOrder, trace);
  try {
    await startDomain(name, trace);
  } finally {
    const restoreOrder = originalOrder.length > 0 ? originalOrder : onceOrder.slice().reverse();
    await setBootOrderInternal(name, restoreOrder, trace).catch(() => {});
  }

  return formatTrace(trace);
}
