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
    return nics;
  } catch {
    return [];
  }
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

export async function attachNic(nameOrId: string, bridge: string, model = 'virtio', mac?: string): Promise<string> {
  const trace: TraceEntry[] = [];
  const macFlag = mac ? ` --mac ${mac}` : '';
  await virsh(`attach-interface ${nameOrId} bridge ${bridge} --model ${model}${macFlag} --persistent`, trace);
  return formatTrace(trace);
}

export async function detachNic(nameOrId: string, mac: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(`detach-interface ${nameOrId} bridge --mac ${mac} --persistent`, trace);
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
    return snapshots;
  } catch {
    return [];
  }
}

// Internal QEMU snapshots on a running VM can take >30s for large disks/memory
const SNAPSHOT_TIMEOUT = 3 * 60_000;

export async function createSnapshot(nameOrId: string, snapshotName: string, description?: string): Promise<string> {
  const trace: TraceEntry[] = [];

  // Freeze guest filesystems for a consistent snapshot. Falls through silently
  // if the agent is absent or the VM is stopped.
  let frozen = false;
  try {
    await execAsync(
      `virsh -c ${config.libvirtUri} qemu-agent-command "${nameOrId}" '{"execute":"guest-fsfreeze-freeze"}' --timeout 5`,
      { timeout: 10_000 },
    );
    frozen = true;
  } catch { /* agent absent or VM not running — proceed unfrozen */ }

  try {
    const args = description
      ? `snapshot-create-as ${nameOrId} ${snapshotName} "${description}" --atomic`
      : `snapshot-create-as ${nameOrId} ${snapshotName} --atomic`;
    await virsh(args, trace, SNAPSHOT_TIMEOUT);
  } finally {
    if (frozen) {
      try {
        await execAsync(
          `virsh -c ${config.libvirtUri} qemu-agent-command "${nameOrId}" '{"execute":"guest-fsfreeze-thaw"}' --timeout 5`,
          { timeout: 10_000 },
        );
      } catch { /* best-effort */ }
    }
  }

  return formatTrace(trace);
}

export async function deleteSnapshot(nameOrId: string, snapshotName: string): Promise<string> {
  const trace: TraceEntry[] = [];
  await virsh(`snapshot-delete ${nameOrId} ${snapshotName}`, trace, SNAPSHOT_TIMEOUT);
  return formatTrace(trace);
}

export async function revertSnapshot(nameOrId: string, snapshotName: string): Promise<string> {
  const trace: TraceEntry[] = [];
  try { await virsh(`destroy ${nameOrId}`, trace); } catch { /* already stopped */ }
  await virsh(`snapshot-revert ${nameOrId} ${snapshotName} --force`, trace, SNAPSHOT_TIMEOUT);
  // snapshot-revert --force may have already started the VM (e.g. snapshot taken while running)
  const state = await virsh(`domstate ${nameOrId}`);
  if (parseStatus(state) !== 'running') {
    await virsh(`start ${nameOrId}`, trace);
  }
  return formatTrace(trace);
}

export async function exportSnapshotAsTemplate(vmName: string, snapshotName: string, templateFilename: string): Promise<string> {
  const disks = await getVmDisks(vmName);
  const primaryDisk = disks.find((d) => d.target === 'vda' && d.source);
  if (!primaryDisk?.source) throw new Error('Primary disk (vda) not found or has no source path');
  const destPath = path.join(config.templatesDir, templateFilename);
  const trace: TraceEntry[] = [];
  await execTraced(
    `qemu-img convert -U -f qcow2 -O qcow2 -l "snapshot.name=${snapshotName}" "${primaryDisk.source}" "${destPath}"`,
    trace,
    { timeout: 300_000 }
  );
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
