import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { config } from '../config.js';
import type { Vm, VmDisk, VmNic, VmStatus, VmSnapshot, VmSummary, VmStatsSample, VmStatsResponse } from '../types.js';
import { type TraceEntry, formatTrace } from './traceService.js';
import { run, virsh as safeVirsh } from './safeExec.js';
import {
  validateVmName,
  validateSnapshotName,
  validateBridgeName,
  validateMac,
  validateDiskTarget,
  validateNonNegativeInt,
} from '../lib/validate.js';

// Most callers now pass a UUID; listVmsRaw() still passes a name when
// fanning out to per-VM `getVmInfo` lookups, so internal validators must
// accept both shapes. validateVmName's regex (`[A-Za-z0-9][A-Za-z0-9._-]{0,62}`)
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

export async function listVmsRaw(): Promise<VmSummary[]> {
  const out = await virsh(['list', '--all']);
  const lines = out.split('\n').slice(2).filter(Boolean);
  const vms: VmSummary[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 3) continue;
    const name = parts[1].trim();
    const stateStr = parts[2].trim();
    try {
      const info = await getVmInfo(name);
      vms.push({ id: info.id, name, status: parseStatus(stateStr), cpus: info.cpus, memoryMb: info.memoryMb, autostart: info.autostart });
    } catch {
      vms.push({ id: name, name, status: parseStatus(stateStr), cpus: 0, memoryMb: 0 });
    }
  }

  // Fan out guest-agent pings in parallel — only meaningful for running VMs.
  const runningVms = vms.filter((v) => v.status === 'running');
  if (runningVms.length > 0) {
    const results = await Promise.allSettled(
      runningVms.map((v) => checkGuestAgent(v.name).then((ok) => ({ name: v.name, ok }))),
    );
    const agentMap = new Map(
      results
        .filter((r): r is PromiseFulfilledResult<{ name: string; ok: boolean }> => r.status === 'fulfilled')
        .map((r) => [r.value.name, r.value.ok]),
    );
    for (const vm of vms) {
      if (vm.status === 'running') vm.guestAgent = agentMap.get(vm.name) ?? false;
    }
  }

  return vms;
}

export async function getVmInfo(nameOrId: string): Promise<Vm> {
  const name = validateVmName(nameOrId);
  const info = await virsh(['dominfo', name]);
  const lines = info.split('\n');

  const get = (key: string): string => {
    const line = lines.find((l) => l.startsWith(key));
    return line?.split(':')[1]?.trim() ?? '';
  };

  const id = get('UUID');
  const vmName = get('Name');
  const stateStr = get('State');
  const cpus = parseInt(get('CPU(s)') || '0', 10);
  const memKb = parseInt(get('Used memory').replace(/[^0-9]/g, '') || '0', 10);
  const memoryMb = Math.round(memKb / 1024);
  const autostart = get('Autostart').toLowerCase() === 'enable';

  const disks = await getVmDisks(name);
  const nics = await getVmNics(name);

  try {
    const xml = await getVmXml(name);
    const bootMap = parseBootOrderFromXml(xml);
    for (const disk of disks) {
      disk.bootOrder = bootMap.get(disk.target);
    }
  } catch {
    // non-fatal — boot order display degrades gracefully
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

  const status = parseStatus(stateStr);
  const guestAgent = status === 'running' ? await checkGuestAgent(name) : undefined;

  return { id, name: vmName, status, cpus, memoryMb, disks, nics, vncDisplay, vncPort, guestAgent, autostart };
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
      const bus = parts[0];
      const type = parts[1] as 'disk' | 'cdrom';
      const target = parts[2];
      const source = parts[3] === '-' ? '' : parts[3];
      disks.push({ target, source, type, bus });
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

    return disks;
  } catch {
    return [];
  }
}

export async function getVmNics(nameOrId: string): Promise<VmNic[]> {
  const name = validateVmName(nameOrId);
  try {
    const out = await virsh(['domiflist', name]);
    const lines = out.split('\n').slice(2).filter(Boolean);
    const nics: VmNic[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const target = parts[0];
      const source = parts[2];
      const model = parts[3];
      const mac = parts[4];
      nics.push({ mac, source, model, target });
    }

    try {
      const xml = await virsh(['dumpxml', name, '--inactive']);
      const bandwidthByMac = parseNicBandwidthFromXml(xml);
      for (const nic of nics) {
        const bw = bandwidthByMac.get(nic.mac.toLowerCase());
        if (bw) {
          if (bw.inboundKbps !== undefined) nic.inboundKbps = bw.inboundKbps;
          if (bw.outboundKbps !== undefined) nic.outboundKbps = bw.outboundKbps;
        }
      }
    } catch {
      // bandwidth info is best-effort; ignore if dumpxml fails
    }

    return nics;
  } catch {
    return [];
  }
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

export async function getVmInterfaceIps(nameOrId: string): Promise<Record<string, string>> {
  const name = validateVmName(nameOrId);
  for (const source of ['agent', 'arp'] as const) {
    try {
      const out = await virsh(['domifaddr', name, '--source', source]);
      const result: Record<string, string> = {};
      for (const line of out.split('\n').slice(2).filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const mac = parts[1];
        const addr = parts[3];
        const ip = addr?.split('/')[0];
        if (mac && ip) result[mac] = ip;
      }
      if (Object.keys(result).length > 0) return result;
    } catch {}
  }
  return {};
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
  await virsh(['start', name], trace);
  return formatTrace(trace);
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
  await virsh(['undefine', name, ...flags], trace);
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
): Promise<string> {
  const name = validateVmName(nameOrId);
  const br = validateBridgeName(bridge);
  // Model is from a fixed set so a regex is sufficient.
  if (!/^[a-z0-9-]{1,32}$/.test(model)) throw new Error('Invalid NIC model');
  const trace: TraceEntry[] = [];
  const args = ['attach-interface', name, 'bridge', br, '--model', model];
  if (mac) {
    const m = validateMac(mac);
    args.push('--mac', m);
  }
  args.push('--persistent');
  await virsh(args, trace);

  if (mac && bandwidth && (bandwidth.inboundKbps || bandwidth.outboundKbps)) {
    await setNicBandwidth(name, mac, bandwidth, trace);
  }

  return formatTrace(trace);
}

export async function detachNic(nameOrId: string, mac: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const m = validateMac(mac);
  const trace: TraceEntry[] = [];
  await virsh(['detach-interface', name, 'bridge', '--mac', m, '--persistent'], trace);
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
  const isRunning = parseStatus(state) === 'running';
  const scope = isRunning ? ['--live', '--config'] : ['--config'];

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
            const stdout = await run('qemu-img', ['info', '--force-share', '--output=json', d.source]);
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

async function fsFreeze(nameOrId: string): Promise<boolean> {
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

async function fsThaw(nameOrId: string): Promise<void> {
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
  const uefi = await isUefiVm(name);

  const frozen = await fsFreeze(name);

  try {
    if (uefi) {
      const disks = await getVmDisks(name);
      const persistent = disks.filter((d) => d.type === 'disk' && d.source && /\.qcow2$/i.test(d.source));
      if (persistent.length === 0) {
        throw new Error('No qcow2 disks found to snapshot');
      }
      const args = ['snapshot-create-as', name, snap];
      if (description) args.push(description);
      args.push('--disk-only', '--atomic');
      for (const d of persistent) {
        const dir = path.dirname(d.source);
        const overlay = path.join(dir, `${name}-${d.target}-${snap}.qcow2`);
        args.push('--diskspec', `${d.target},file=${overlay},snapshot=external`);
      }
      for (const d of disks) {
        if (!persistent.find((p) => p.target === d.target)) {
          args.push('--diskspec', `${d.target},snapshot=no`);
        }
      }
      await virsh(args, trace, SNAPSHOT_TIMEOUT);
    } else {
      const args = ['snapshot-create-as', name, snap];
      if (description) args.push(description);
      args.push('--atomic');
      await virsh(args, trace, SNAPSHOT_TIMEOUT);
    }
  } finally {
    if (frozen) await fsThaw(name);
  }

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
    if (running) {
      const chainJson = await run('qemu-img', ['info', '--force-share', '--output=json', '--backing-chain', sd.file]);
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
      await run('qemu-img', ['commit', '-d', sd.file], { timeout: SNAPSHOT_TIMEOUT, trace });
      const stdout = await run('qemu-img', ['info', '--output=json', '--backing-chain', sd.file]);
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

  return formatTrace(trace);
}

export async function revertSnapshot(nameOrId: string, snapshotName: string): Promise<string> {
  const name = validateVmName(nameOrId);
  const snap = validateSnapshotName(snapshotName);
  const trace: TraceEntry[] = [];
  const snapshotXml = await getSnapshotXml(name, snap);

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
      await run('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', sealed, overlay], { timeout: 60_000, trace });
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

  const state = await virsh(['domstate', name]);
  if (parseStatus(state) !== 'running') {
    await virsh(['start', name], trace);
  }
  return formatTrace(trace);
}

export async function exportSnapshotAsTemplate(vmName: string, snapshotName: string, templateFilename: string): Promise<string> {
  const name = validateVmName(vmName);
  const snap = validateSnapshotName(snapshotName);
  // templateFilename comes from the route layer, which already runs it
  // through validateFilename — but we re-basename here as defence-in-depth.
  const safeFilename = path.basename(templateFilename);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(qcow2|img|raw)$/i.test(safeFilename)) {
    throw new Error('Invalid template filename');
  }
  const trace: TraceEntry[] = [];
  const destPath = path.join(config.templatesDir, safeFilename);
  const snapshotXml = await getSnapshotXml(name, snap);

  if (isExternalSnapshotXml(snapshotXml)) {
    const savedXml = extractSavedDomainXml(snapshotXml);
    if (!savedXml) throw new Error('Snapshot XML missing saved <domain> element');
    const sealed = parseDiskSourceFromDomainXml(savedXml, 'vda');
    if (!sealed) throw new Error('Snapshot does not include vda');
    await run(
      'qemu-img',
      ['convert', '-U', '-f', 'qcow2', '-O', 'qcow2', sealed, destPath],
      { timeout: 300_000, trace },
    );
  } else {
    const disks = await getVmDisks(name);
    const primaryDisk = disks.find((d) => d.target === 'vda' && d.source);
    if (!primaryDisk?.source) throw new Error('Primary disk (vda) not found or has no source path');
    await run(
      'qemu-img',
      ['convert', '-U', '-f', 'qcow2', '-O', 'qcow2', '-l', `snapshot.name=${snap}`, primaryDisk.source, destPath],
      { timeout: 300_000, trace },
    );
  }
  return formatTrace(trace);
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

  const state = await virsh(['domstate', name]);
  const running = parseStatus(state) === 'running';

  if (running) {
    const stdout = await run('qemu-img', ['info', '-U', '--output=json', disk.source]);
    const info = JSON.parse(stdout) as { 'virtual-size': number };
    const newSizeBytes = info['virtual-size'] + addGb * 1024 * 1024 * 1024;
    await virsh(['blockresize', name, tgt, `${newSizeBytes}b`], trace);
  } else {
    await run('qemu-img', ['resize', disk.source, `+${addGb}G`], { timeout: 120_000, trace });
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
    const balloonCurrentKiB = get('balloon.current');
    const balloonMaxKiB = get('balloon.maximum');
    const balloonAvailableKiB = s.get('balloon.available');
    const balloonUnusedKiB = s.get('balloon.unused');

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

    let memUsedMb: number;
    let memTotalMb: number;
    if (balloonAvailableKiB != null && balloonUnusedKiB != null) {
      memTotalMb = Math.round(balloonAvailableKiB / 1024);
      memUsedMb = Math.round((balloonAvailableKiB - balloonUnusedKiB) / 1024);
    } else {
      memTotalMb = Math.round(balloonMaxKiB / 1024);
      memUsedMb = Math.round(balloonCurrentKiB / 1024);
    }

    const sample: VmStatsSample = {
      timestamp: now,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      memUsedMb,
      memTotalMb,
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
    await virsh(['start', name], trace);
  } finally {
    const restoreOrder = originalOrder.length > 0 ? originalOrder : onceOrder.slice().reverse();
    await setBootOrderInternal(name, restoreOrder, trace).catch(() => {});
  }

  return formatTrace(trace);
}
