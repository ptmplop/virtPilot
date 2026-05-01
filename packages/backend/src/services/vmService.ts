import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { config } from '../config.js';
import type { Vm, VmDisk, VmNic, VmStatus, VmSnapshot, VmSummary, VmStatsSample, VmStatsResponse } from '../types.js';
import { type TraceEntry, formatTrace, execTraced } from './traceService.js';

const execAsync = promisify(exec);

// ─── Internal virsh helper ────────────────────────────────────────────────────

async function virsh(args: string, trace?: TraceEntry[], timeout = 30_000): Promise<string> {
  const cmd = `virsh -c ${config.libvirtUri} ${args}`;
  if (!trace) {
    const { stdout } = await execAsync(cmd, { timeout });
    return stdout.trim();
  }
  return execTraced(cmd, trace, { timeout });
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
  const out = await virsh('list --all --uuid');
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
  const out = await virsh('list --all');
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
  const info = await virsh(`dominfo ${nameOrId}`);
  const lines = info.split('\n');

  const get = (key: string): string => {
    const line = lines.find((l) => l.startsWith(key));
    return line?.split(':')[1]?.trim() ?? '';
  };

  const id = get('UUID');
  const name = get('Name');
  const stateStr = get('State');
  const cpus = parseInt(get('CPU(s)') || '0', 10);
  const memKb = parseInt(get('Used memory').replace(/[^0-9]/g, '') || '0', 10);
  const memoryMb = Math.round(memKb / 1024);
  const autostart = get('Autostart').toLowerCase() === 'enable';

  const disks = await getVmDisks(nameOrId);
  const nics = await getVmNics(nameOrId);

  try {
    const xml = await getVmXml(nameOrId);
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
    const vnc = await virsh(`vncdisplay ${nameOrId}`);
    vncDisplay = vnc.trim();
    const portMatch = vncDisplay.match(/:(\d+)/);
    if (portMatch) vncPort = 5900 + parseInt(portMatch[1], 10);
  } catch {
    // VNC not available (VM stopped)
  }

  const status = parseStatus(stateStr);
  const guestAgent = status === 'running' ? await checkGuestAgent(nameOrId) : undefined;

  return { id, name, status, cpus, memoryMb, disks, nics, vncDisplay, vncPort, guestAgent, autostart };
}

export async function getVmDisks(nameOrId: string): Promise<VmDisk[]> {
  try {
    const out = await virsh(`domblklist ${nameOrId} --details`);
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

    // Fetch capacity for each disk in parallel via domblkinfo
    await Promise.all(
      disks.map(async (disk) => {
        try {
          const info = await virsh(`domblkinfo ${nameOrId} ${disk.target}`);
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
  try {
    const out = await virsh(`domiflist ${nameOrId}`);
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

    // Pull <bandwidth> from the inactive XML so values are correct whether the VM is running or stopped.
    try {
      const xml = await virsh(`dumpxml ${nameOrId} --inactive`);
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
  for (const source of ['agent', 'arp'] as const) {
    try {
      const out = await virsh(`domifaddr ${nameOrId} --source ${source}`);
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
    await execAsync(
      `virsh -c ${config.libvirtUri} qemu-agent-command "${nameOrId}" '{"execute":"guest-ping"}' --timeout 3`,
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function startVm(nameOrId: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(`start ${nameOrId}`, trace);
  return formatTrace(trace);
}

export async function stopVm(nameOrId: string, force = false): Promise<string> {
  const trace: TraceEntry[] = [];
  if (force) {
    await virsh(`destroy ${nameOrId}`, trace);
  } else {
    await virsh(`shutdown ${nameOrId}`, trace);
  }
  return formatTrace(trace);
}

export async function rebootVm(nameOrId: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(`reboot ${nameOrId}`, trace);
  return formatTrace(trace);
}

export async function hardRebootVm(nameOrId: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(`reset ${nameOrId}`, trace);
  return formatTrace(trace);
}

export async function deleteVm(nameOrId: string, deleteStorage = false): Promise<string> {
  const trace: TraceEntry[] = [];
  try { await virsh(`destroy ${nameOrId}`, trace); } catch { /* already stopped */ }
  const flags = [
    '--snapshots-metadata',
    '--nvram',
    '--tpm',
    deleteStorage ? '--remove-all-storage' : '',
  ].filter(Boolean).join(' ');
  await virsh(`undefine ${nameOrId} ${flags}`, trace);
  return formatTrace(trace);
}

export async function defineVm(xmlPath: string, trace?: TraceEntry[]): Promise<void> {
  await virsh(`define ${xmlPath}`, trace);
}

export async function attachDisk(nameOrId: string, sourcePath: string, targetDev: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(
    `attach-disk ${nameOrId} --source ${sourcePath} --target ${targetDev} ` +
    `--driver qemu --subdriver qcow2 --persistent`,
    trace
  );
  return formatTrace(trace);
}

export async function detachDisk(nameOrId: string, targetDev: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(`detach-disk ${nameOrId} ${targetDev} --persistent`, trace);
  return formatTrace(trace);
}

export async function attachCdrom(nameOrId: string, isoPath: string, targetDev = 'sdb'): Promise<string> {
  const trace: TraceEntry[] = [];
  const state = await virsh(`domstate ${nameOrId}`);
  const flags = parseStatus(state) === 'running' ? '--live --config' : '--config';
  await virsh(`change-media ${nameOrId} ${targetDev} ${isoPath} ${flags}`, trace);
  return formatTrace(trace);
}

export async function detachCdrom(nameOrId: string, targetDev = 'sdb'): Promise<string> {
  const trace: TraceEntry[] = [];
  const state = await virsh(`domstate ${nameOrId}`);
  const flags = parseStatus(state) === 'running' ? '--eject --live --config' : '--eject --config';
  await virsh(`change-media ${nameOrId} ${targetDev} ${flags}`, trace);
  return formatTrace(trace);
}

export async function attachNic(
  nameOrId: string,
  bridge: string,
  model = 'virtio',
  mac?: string,
  bandwidth?: { inboundKbps?: number; outboundKbps?: number },
): Promise<string> {
  const trace: TraceEntry[] = [];
  const macFlag = mac ? ` --mac ${mac}` : '';
  await virsh(`attach-interface ${nameOrId} bridge ${bridge} --model ${model}${macFlag} --persistent`, trace);

  if (mac && bandwidth && (bandwidth.inboundKbps || bandwidth.outboundKbps)) {
    await setNicBandwidth(nameOrId, mac, bandwidth, trace);
  }

  return formatTrace(trace);
}

export async function detachNic(nameOrId: string, mac: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(`detach-interface ${nameOrId} bridge --mac ${mac} --persistent`, trace);
  return formatTrace(trace);
}

export async function setNicBandwidth(
  nameOrId: string,
  mac: string,
  bandwidth: { inboundKbps?: number; outboundKbps?: number },
  existingTrace?: TraceEntry[],
): Promise<string> {
  const trace = existingTrace ?? [];
  const state = await virsh(`domstate ${nameOrId}`);
  const isRunning = parseStatus(state) === 'running';
  const scope = isRunning ? '--live --config' : '--config';

  // domiftune average=0 clears the limit. Use 0 for unlimited so the user can clear caps.
  const inboundKbps = bandwidth.inboundKbps ?? 0;
  const outboundKbps = bandwidth.outboundKbps ?? 0;

  await virsh(
    `domiftune ${nameOrId} ${mac} --inbound ${inboundKbps} --outbound ${outboundKbps} ${scope}`,
    trace,
  );
  return formatTrace(trace);
}

// ─── Boot Order ───────────────────────────────────────────────────────────────

export async function getVmXml(nameOrId: string): Promise<string> {
  return virsh(`dumpxml ${nameOrId} --inactive`);
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
  const xml = await getVmXml(nameOrId);
  const newXml = applyBootOrderToXml(xml, bootOrder);
  const tmpPath = path.join(os.tmpdir(), `virtpilot-boot-${nameOrId}-${Date.now()}.xml`);
  await fs.writeFile(tmpPath, newXml, 'utf8');
  try {
    await virsh(`define ${tmpPath}`, trace);
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

// UEFI VMs (pflash firmware) can't store internal snapshots — QEMU has nowhere
// to put the savevm state alongside pflash. We fall back to external disk-only
// snapshots, which create a new qcow2 overlay on top of each persistent disk.
async function isUefiVm(nameOrId: string): Promise<boolean> {
  try {
    const xml = await virsh(`dumpxml ${nameOrId}`);
    return /<loader\b[^>]*type=['"]pflash['"]/i.test(xml);
  } catch {
    return false;
  }
}

async function getSnapshotXml(nameOrId: string, snapshotName: string): Promise<string> {
  return virsh(`snapshot-dumpxml ${nameOrId} ${snapshotName}`);
}

function isExternalSnapshotXml(snapshotXml: string): boolean {
  return /snapshot=['"]external['"]/.test(snapshotXml);
}

// Pulls each external-disk entry out of a snapshot XML's <disks> section.
// `file` is the new overlay that became active when the snapshot was taken.
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

// Extracts the source file for a given disk target from a domain XML blob.
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
  try {
    const out = await virsh(`snapshot-list ${nameOrId}`);
    const lines = out.split('\n').slice(2).filter(Boolean);
    const snapshots: VmSnapshot[] = [];
    const lineRegex = /^\s*(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(\S+)\s*$/;
    for (const line of lines) {
      const match = line.match(lineRegex);
      if (!match) continue;
      const [, name, createdAt, vmState] = match;
      snapshots.push({ name, createdAt: new Date(createdAt).toISOString(), vmState });
    }

    // Resolve sizes in parallel. Internal snapshots need disk paths to look up
    // vm-state-size via qemu-img; fetch them once and reuse.
    if (snapshots.length > 0) {
      const vmDisks = await getVmDisks(nameOrId);
      await Promise.all(
        snapshots.map(async (snap) => {
          snap.sizeBytes = await getSnapshotSizeBytes(nameOrId, snap.name, vmDisks);
        }),
      );
    }

    return snapshots;
  } catch {
    return [];
  }
}

// Returns the on-disk cost of a snapshot.
// External: sum of overlay file sizes (post-snapshot writes — i.e. the extra
//   space the snapshot is keeping around).
// Internal: vm-state-size from qemu-img info (saved RAM). Per-snapshot disk
//   delta isn't exposed by qcow2, so this is the closest meaningful figure.
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
            const { stdout } = await execAsync(`qemu-img info --force-share --output=json "${d.source}"`);
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

// Internal QEMU snapshots on a running VM can take >30s for large disks/memory
const SNAPSHOT_TIMEOUT = 3 * 60_000;

async function fsFreeze(nameOrId: string): Promise<boolean> {
  try {
    await execAsync(
      `virsh -c ${config.libvirtUri} qemu-agent-command "${nameOrId}" '{"execute":"guest-fsfreeze-freeze"}' --timeout 5`,
      { timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function fsThaw(nameOrId: string): Promise<void> {
  try {
    await execAsync(
      `virsh -c ${config.libvirtUri} qemu-agent-command "${nameOrId}" '{"execute":"guest-fsfreeze-thaw"}' --timeout 5`,
      { timeout: 10_000 },
    );
  } catch { /* best-effort */ }
}

export async function createSnapshot(nameOrId: string, snapshotName: string, description?: string): Promise<string> {
  const trace: TraceEntry[] = [];
  const uefi = await isUefiVm(nameOrId);

  // Freeze guest filesystems for a consistent snapshot. Falls through silently
  // if the agent is absent or the VM is stopped.
  const frozen = await fsFreeze(nameOrId);

  try {
    const desc = description ? `"${description}"` : '';
    if (uefi) {
      // External disk-only snapshot: each persistent qcow2 disk gets a new
      // overlay, the previous file is sealed and becomes the backing chain.
      // CD-ROMs and other non-qcow2 disks are excluded (snapshot=no).
      const disks = await getVmDisks(nameOrId);
      const persistent = disks.filter((d) => d.type === 'disk' && d.source && /\.qcow2$/i.test(d.source));
      if (persistent.length === 0) {
        throw new Error('No qcow2 disks found to snapshot');
      }
      const diskspecs: string[] = [];
      for (const d of persistent) {
        const dir = path.dirname(d.source);
        const overlay = path.join(dir, `${nameOrId}-${d.target}-${snapshotName}.qcow2`);
        diskspecs.push(`--diskspec ${d.target},file=${overlay},snapshot=external`);
      }
      for (const d of disks) {
        if (!persistent.find((p) => p.target === d.target)) {
          diskspecs.push(`--diskspec ${d.target},snapshot=no`);
        }
      }
      const args = `snapshot-create-as ${nameOrId} ${snapshotName} ${desc} --disk-only --atomic ${diskspecs.join(' ')}`.trim();
      await virsh(args, trace, SNAPSHOT_TIMEOUT);
    } else {
      const args = description
        ? `snapshot-create-as ${nameOrId} ${snapshotName} ${desc} --atomic`
        : `snapshot-create-as ${nameOrId} ${snapshotName} --atomic`;
      await virsh(args, trace, SNAPSHOT_TIMEOUT);
    }
  } finally {
    if (frozen) await fsThaw(nameOrId);
  }

  return formatTrace(trace);
}

export async function deleteSnapshot(nameOrId: string, snapshotName: string): Promise<string> {
  const trace: TraceEntry[] = [];
  const snapshotXml = await getSnapshotXml(nameOrId, snapshotName);

  if (!isExternalSnapshotXml(snapshotXml)) {
    await virsh(`snapshot-delete ${nameOrId} ${snapshotName}`, trace, SNAPSHOT_TIMEOUT);
    return formatTrace(trace);
  }

  // External: merge each overlay back into its backing file, then drop the
  // metadata. Only supported when the snapshot's overlay is currently the
  // active disk (i.e. the topmost snapshot in the chain) — intermediate
  // deletions would require rewriting the chain.
  const snapDisks = parseExternalSnapshotDisks(snapshotXml);
  if (snapDisks.length === 0) throw new Error('Snapshot XML has no external disk entries');

  const liveDisks = await getVmDisks(nameOrId);
  for (const sd of snapDisks) {
    const live = liveDisks.find((d) => d.target === sd.target);
    if (!live?.source) {
      throw new Error(`Disk ${sd.target} not present on VM`);
    }
    if (path.resolve(live.source) !== path.resolve(sd.file)) {
      throw new Error(
        `Cannot delete snapshot '${snapshotName}': overlay for ${sd.target} is no longer the active disk (a newer snapshot exists). Delete newer snapshots first.`,
      );
    }
  }

  const stateOut = await virsh(`domstate ${nameOrId}`);
  const running = parseStatus(stateOut) === 'running';
  const overlayFiles: string[] = [];

  for (const sd of snapDisks) {
    overlayFiles.push(sd.file);
    if (running) {
      // Without --top/--base, blockcommit walks the entire chain down to the
      // bottom-most backing file — which for VMs cloned from a shared template
      // is read-only and held by other domains, producing a "Failed to get
      // write lock" error. Pin the merge to overlay → immediate backing only.
      const { stdout: chainJson } = await execAsync(
        `qemu-img info --force-share --output=json --backing-chain "${sd.file}"`,
      );
      const chain = JSON.parse(chainJson) as Array<{ filename: string; 'backing-filename'?: string }>;
      const backing = chain[0]?.['backing-filename'];
      if (!backing) throw new Error(`Could not determine backing file for ${sd.file}`);
      const backingAbs = path.isAbsolute(backing) ? backing : path.resolve(path.dirname(sd.file), backing);
      // Active commit: merge active overlay into its backing and pivot the
      // domain to use the (now updated) backing file as the active disk.
      await virsh(
        `blockcommit ${nameOrId} ${sd.target} --active --pivot --wait --verbose --top "${sd.file}" --base "${backingAbs}"`,
        trace,
        SNAPSHOT_TIMEOUT,
      );
    } else {
      // Offline: qemu-img commits the overlay into its backing in-place.
      await execTraced(`qemu-img commit -d "${sd.file}"`, trace, { timeout: SNAPSHOT_TIMEOUT });
      // Repoint the domain at the backing file.
      const { stdout } = await execAsync(`qemu-img info --output=json --backing-chain "${sd.file}"`);
      const chain = JSON.parse(stdout) as Array<{ filename: string; 'backing-filename'?: string }>;
      const backing = chain[0]?.['backing-filename'];
      if (!backing) throw new Error(`Could not determine backing file for ${sd.file}`);
      const backingAbs = path.isAbsolute(backing) ? backing : path.resolve(path.dirname(sd.file), backing);
      const domXml = await getVmXml(nameOrId);
      const updated = domXml.replace(
        new RegExp(`(<source\\s+file=['"])${escapeRegex(sd.file)}(['"])`),
        `$1${backingAbs}$2`,
      );
      if (updated === domXml) {
        throw new Error(`Failed to rewrite domain XML for ${sd.target}`);
      }
      const tmp = path.join(os.tmpdir(), `virtpilot-snapdel-${nameOrId}-${Date.now()}.xml`);
      await fs.writeFile(tmp, updated, 'utf8');
      try {
        await virsh(`define ${tmp}`, trace);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    }
  }

  await virsh(`snapshot-delete ${nameOrId} ${snapshotName} --metadata`, trace, SNAPSHOT_TIMEOUT);

  // Clean up the now-merged overlay files.
  for (const f of overlayFiles) {
    await fs.unlink(f).catch(() => { /* best-effort */ });
  }

  return formatTrace(trace);
}

export async function revertSnapshot(nameOrId: string, snapshotName: string): Promise<string> {
  const trace: TraceEntry[] = [];
  const snapshotXml = await getSnapshotXml(nameOrId, snapshotName);

  try { await virsh(`destroy ${nameOrId}`, trace); } catch { /* already stopped */ }

  if (!isExternalSnapshotXml(snapshotXml)) {
    await virsh(`snapshot-revert ${nameOrId} ${snapshotName} --force`, trace, SNAPSHOT_TIMEOUT);
  } else {
    // External: restore the saved domain XML from the snapshot, then create a
    // fresh overlay so the snapshot's frozen file stays sealed and re-revertible.
    const savedXml = extractSavedDomainXml(snapshotXml);
    if (!savedXml) throw new Error('Snapshot XML missing saved <domain> element');

    // Identify which disks the snapshot froze, find their files in the saved
    // domain, and cap each with a new overlay so writes don't dirty the
    // snapshot point.
    const snapDisks = parseExternalSnapshotDisks(snapshotXml);
    let pivotedXml = savedXml;
    const stamp = Date.now();
    for (const sd of snapDisks) {
      const sealed = parseDiskSourceFromDomainXml(savedXml, sd.target);
      if (!sealed) continue;
      const dir = path.dirname(sealed);
      const overlay = path.join(dir, `${nameOrId}-${sd.target}-revert-${stamp}.qcow2`);
      await execTraced(
        `qemu-img create -f qcow2 -F qcow2 -b "${sealed}" "${overlay}"`,
        trace,
        { timeout: 60_000 },
      );
      pivotedXml = pivotedXml.replace(
        new RegExp(`(<source\\s+file=['"])${escapeRegex(sealed)}(['"])`),
        `$1${overlay}$2`,
      );
    }

    const tmp = path.join(os.tmpdir(), `virtpilot-revert-${nameOrId}-${stamp}.xml`);
    await fs.writeFile(tmp, pivotedXml, 'utf8');
    try {
      await virsh(`define ${tmp}`, trace);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  const state = await virsh(`domstate ${nameOrId}`);
  if (parseStatus(state) !== 'running') {
    await virsh(`start ${nameOrId}`, trace);
  }
  return formatTrace(trace);
}

export async function exportSnapshotAsTemplate(vmName: string, snapshotName: string, templateFilename: string): Promise<string> {
  const trace: TraceEntry[] = [];
  const destPath = path.join(config.templatesDir, templateFilename);
  const snapshotXml = await getSnapshotXml(vmName, snapshotName);

  if (isExternalSnapshotXml(snapshotXml)) {
    // The snapshot's vda data lives in the saved domain XML's vda source —
    // that file became the read-only backing when the snapshot was taken.
    // qemu-img convert resolves any deeper backing chain automatically.
    const savedXml = extractSavedDomainXml(snapshotXml);
    if (!savedXml) throw new Error('Snapshot XML missing saved <domain> element');
    const sealed = parseDiskSourceFromDomainXml(savedXml, 'vda');
    if (!sealed) throw new Error('Snapshot does not include vda');
    await execTraced(
      `qemu-img convert -U -f qcow2 -O qcow2 "${sealed}" "${destPath}"`,
      trace,
      { timeout: 300_000 },
    );
  } else {
    const disks = await getVmDisks(vmName);
    const primaryDisk = disks.find((d) => d.target === 'vda' && d.source);
    if (!primaryDisk?.source) throw new Error('Primary disk (vda) not found or has no source path');
    await execTraced(
      `qemu-img convert -U -f qcow2 -O qcow2 -l "snapshot.name=${snapshotName}" "${primaryDisk.source}" "${destPath}"`,
      trace,
      { timeout: 300_000 },
    );
  }
  return formatTrace(trace);
}

// ─── Boot Once ────────────────────────────────────────────────────────────────

// ─── Autostart ────────────────────────────────────────────────────────────────

export async function setAutostart(nameOrId: string, enabled: boolean): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(enabled ? `autostart ${nameOrId}` : `autostart --disable ${nameOrId}`, trace);
  return formatTrace(trace);
}

// ─── Disk resize ──────────────────────────────────────────────────────────────

export async function resizeDisk(nameOrId: string, target: string, addGb: number): Promise<string> {
  const trace: TraceEntry[] = [];

  const disks = await getVmDisks(nameOrId);
  const disk = disks.find((d) => d.target === target);
  if (!disk?.source) throw new Error(`Disk ${target} not found or has no source path`);

  const state = await virsh(`domstate ${nameOrId}`);
  const running = parseStatus(state) === 'running';

  if (running) {
    // QEMU holds a write lock on the image while running — qemu-img resize would fail.
    // virsh blockresize talks directly to QEMU, resizes the image, and notifies the guest.
    const { stdout } = await execAsync(`qemu-img info -U --output=json "${disk.source}"`);
    const info = JSON.parse(stdout) as { 'virtual-size': number };
    const newSizeBytes = info['virtual-size'] + addGb * 1024 * 1024 * 1024;
    // Append 'b' to force bytes — virsh 10 defaults to KiB for bare numbers
    await virsh(`blockresize ${nameOrId} ${target} ${newSizeBytes}b`, trace);
  } else {
    await execTraced(`qemu-img resize "${disk.source}" +${addGb}G`, trace, { timeout: 120_000 });
  }

  return formatTrace(trace);
}

// ─── Resource editing (CPU + RAM) ─────────────────────────────────────────────

export async function updateVmResources(nameOrId: string, cpus: number, memoryMb: number): Promise<string> {
  const trace: TraceEntry[] = [];
  const xml = await getVmXml(nameOrId);
  const memKib = memoryMb * 1024;

  let newXml = xml
    .replace(/<vcpu[^>]*>[0-9]+<\/vcpu>/, `<vcpu placement="static">${cpus}</vcpu>`)
    .replace(/<memory unit=['"]KiB['"]>[0-9]+<\/memory>/, `<memory unit="KiB">${memKib}</memory>`)
    .replace(/<currentMemory unit=['"]KiB['"]>[0-9]+<\/currentMemory>/, `<currentMemory unit="KiB">${memKib}</currentMemory>`);

  const tmpPath = path.join(os.tmpdir(), `virtpilot-res-${nameOrId}-${Date.now()}.xml`);
  await fs.writeFile(tmpPath, newXml, 'utf8');
  try {
    await virsh(`define ${tmpPath}`, trace);
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
  try {
    const out = await virsh(`domstats ${nameOrId}`, undefined, 10_000);
    const s = parseDomStats(out);

    const get = (k: string) => s.get(k) ?? 0;
    const cpuTimeNs = get('cpu.time');
    const vcpuCount = get('vcpu.current') || get('vcpu.maximum') || 1;
    const balloonCurrentKiB = get('balloon.current');
    const balloonMaxKiB = get('balloon.maximum');
    const balloonAvailableKiB = s.get('balloon.available');
    const balloonUnusedKiB = s.get('balloon.unused');

    // Sum block I/O across all devices
    const blockCount = get('block.count');
    let blockRdBytes = 0;
    let blockWrBytes = 0;
    for (let i = 0; i < blockCount; i++) {
      blockRdBytes += get(`block.${i}.rd.bytes`);
      blockWrBytes += get(`block.${i}.wr.bytes`);
    }

    // Sum network I/O across all interfaces
    const netCount = get('net.count');
    let netRxBytes = 0;
    let netTxBytes = 0;
    for (let i = 0; i < netCount; i++) {
      netRxBytes += get(`net.${i}.rx.bytes`);
      netTxBytes += get(`net.${i}.tx.bytes`);
    }

    const now = Date.now();
    const prev = vmStatsPrev.get(nameOrId);
    vmStatsPrev.set(nameOrId, { timestamp: now, cpuTimeNs, blockRdBytes, blockWrBytes, netRxBytes, netTxBytes });

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

    // Memory: use guest-reported values (via balloon driver) if available, else show allocated
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

    const hist = vmStatsHistory.get(nameOrId) ?? [];
    hist.push(sample);
    if (hist.length > VM_STATS_HISTORY) hist.shift();
    vmStatsHistory.set(nameOrId, hist);

    return { current: sample, history: [...hist] };
  } catch {
    return null;
  }
}

export async function startVmBootOnce(nameOrId: string, device: 'cdrom' | 'hd'): Promise<string> {
  const trace: TraceEntry[] = [];

  const xml = await getVmXml(nameOrId);
  const bootMap = parseBootOrderFromXml(xml);
  const originalOrder = [...bootMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([t]) => t);

  const diskList = await getVmDisks(nameOrId);
  const deviceTargets = diskList.filter((d) => d.type === device).map((d) => d.target);
  const otherTargets = diskList.filter((d) => d.type !== device).map((d) => d.target);
  const onceOrder = [...deviceTargets, ...otherTargets].filter((t) => t !== 'sda');

  await setBootOrderInternal(nameOrId, onceOrder, trace);
  try {
    await virsh(`start ${nameOrId}`, trace);
  } finally {
    const restoreOrder = originalOrder.length > 0 ? originalOrder : onceOrder.slice().reverse();
    await setBootOrderInternal(nameOrId, restoreOrder, trace).catch(() => {});
  }

  return formatTrace(trace);
}
