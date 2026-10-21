// Passing host PCI and USB devices through to VMs.
//
// Decisions are made in pure code (lib/hostDevices.ts) from a fresh host scan
// (services/hostScan.ts) and the VMs' own definitions. This module does the
// libvirt side:
//   - attach: always to the saved configuration; also to the running guest
//     when that is safe (not a GPU, not a multi-device group) and possible,
//     otherwise the device joins when the VM next starts;
//   - detach: the same in reverse, matched by the exact element in the VM's
//     definition so a device that has left the host can still be removed;
//   - before a start: every reason VFIO would refuse, checked first and said
//     in words.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { TraceEntry } from './traceService.js';
import { virsh as safeVirsh, sudo } from './safeExec.js';
import { getHostFacts, invalidateHostFacts } from './hostScan.js';
import { validateVmName } from '../lib/validate.js';
import type { HostFacts } from '../lib/hostFacts.js';
import {
  buildInventory, evaluateHost, classifyPci, cleanName, formatBarSize, pciName, pciVendor, portFromUsbId, usbKey,
  KIND_ORDER, type AssignmentIndex, type UsbAssignment, type DeviceNote, type GroupMember, type Inventory, type PassthroughDevice, type VmRef,
} from '../lib/hostDevices.js';
import {
  buildPciHostdevXml, buildUsbHostdevXml, domainFirmware, domainMemoryKib, hostdevKey, parseHostdevs,
  type Hostdev,
} from '../lib/hostdevXml.js';
import { translatePassthroughError, virshMessage } from '../lib/passthroughErrors.js';

async function virsh(args: readonly string[], trace?: TraceEntry[], timeout = 60_000): Promise<string> {
  return safeVirsh(args, { timeout, trace });
}

/** BIOS (SeaBIOS) guests crash placing memory windows this large; measured with a 32 GB GPU BAR. */
export const UEFI_ONLY_BAR = 1024 ** 3;

const HELPER = '/usr/local/sbin/virtpilot-passthrough';
const HELPER_CONF = '/etc/virtpilot/passthrough.conf';

// One change at a time: two attaches racing for the same card would both see it free.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  // Whatever happened, drivers and devices may have changed: the next list scans afresh.
  const run = queue.then(fn, fn).finally(invalidateHostFacts);
  queue = run.catch(() => {});
  return run;
}

function kindOf(d: { classCode: string; vendorId: string; memoryBars: number[]; isBridge: boolean }): string | undefined {
  const c = classifyPci(d);
  return c.offer ? c.kind : undefined;
}

export class DeviceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'DeviceError';
  }
}

// ─── VMs and what they have been given ────────────────────────────────────────

export interface VmHostdevs {
  uuid: string;
  name: string;
  running: boolean;
  config: Hostdev[];
  live: Hostdev[];
  configXml: string;
}

function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function readVm(uuid: string, running: boolean): Promise<VmHostdevs | null> {
  try {
    const configXml = await virsh(['dumpxml', '--inactive', uuid]);
    const liveXml = running ? await virsh(['dumpxml', uuid]).catch(() => '') : '';
    return {
      uuid,
      name: configXml.match(/<name>([^<]+)<\/name>/)?.[1] ?? uuid,
      running,
      config: parseHostdevs(configXml),
      live: liveXml ? parseHostdevs(liveXml) : [],
      configXml,
    };
  } catch {
    return null; // undefined between the list and the read
  }
}

export async function listVmHostdevs(): Promise<VmHostdevs[]> {
  const [all, running] = await Promise.all([
    virsh(['list', '--all', '--uuid']).then(lines).catch(() => [] as string[]),
    virsh(['list', '--uuid']).then(lines).catch(() => [] as string[]),
  ]);
  const up = new Set(running);
  const vms = await Promise.all(all.map((uuid) => readVm(uuid, up.has(uuid))));
  return vms.filter((v): v is VmHostdevs => v !== null);
}

async function getVm(uuid: string): Promise<VmHostdevs> {
  const id = validateVmName(uuid);
  const state = (await virsh(['domstate', id]).catch(() => '')).trim();
  if (!state) throw new DeviceError('VM not found', 404);
  const vm = await readVm(id, state === 'running' || state === 'paused' || state === 'in shutdown');
  if (!vm) throw new DeviceError('VM not found', 404);
  return vm;
}

function assignmentIndex(vms: VmHostdevs[]): AssignmentIndex {
  const pci = new Map<string, VmRef[]>();
  const usb = new Map<string, UsbAssignment[]>();
  for (const vm of vms) {
    const ref: VmRef = { uuid: vm.uuid, name: vm.name, running: vm.running };
    for (const h of [...vm.config, ...vm.live]) {
      if (h.type !== 'pci') continue;
      const list = pci.get(h.address) ?? [];
      if (!list.some((v) => v.uuid === vm.uuid)) list.push(ref);
      pci.set(h.address, list);
    }
    // A saved USB hostdev claims what it names: every device with its IDs, or the one
    // at its bus and device. The running copy always carries a resolved address, so it
    // only counts for a device the guest still holds after a detach.
    for (const e of entriesOf(vm)) {
      if (e.h.type !== 'usb' || !e.h.vendorId || !e.h.productId) continue;
      const key = usbKey(e.h.vendorId, e.h.productId);
      const pinned = e.inConfig ? e.h : (parseHostdevs(e.liveXml ?? '')[0] as Extract<Hostdev, { type: 'usb' }> | undefined) ?? e.h;
      usb.set(key, [...(usb.get(key) ?? []), { ...ref, bus: pinned.bus, device: pinned.device }]);
    }
  }
  return { pci, usb };
}

/** Devices the host has been told to keep for VMs (bound to vfio-pci from boot), from the helper's config. */
export async function readKept(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(HELPER_CONF, 'utf8');
    return new Set(raw.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p[0] === 'keep' && p[1]).map((p) => p[1]));
  } catch {
    return new Set();
  }
}

export async function helperAvailable(): Promise<boolean> {
  try {
    await fs.access(HELPER, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ─── The host's list ──────────────────────────────────────────────────────────

export interface DeviceInventory extends Inventory {
  /** "Keep for VMs" and virtual functions need the root helper install.sh puts in place. */
  hostTools: boolean;
}

export async function getDeviceInventory(force = false): Promise<DeviceInventory> {
  const [facts, vms, kept, hostTools] = await Promise.all([getHostFacts(force), listVmHostdevs(), readKept(), helperAvailable()]);
  return { ...buildInventory({ facts, assignments: assignmentIndex(vms), kept }), hostTools };
}

// ─── One VM's devices ─────────────────────────────────────────────────────────

export type VmDeviceState = 'attached' | 'pending-attach' | 'pending-detach' | 'missing';

export interface VmDevice {
  /** Detach key of the lead device; `keys` holds every hostdev that leaves with it. */
  key: string;
  keys: string[];
  type: 'pci' | 'usb';
  name: string;
  vendor: string;
  kindLabel: string;
  address: string;
  state: VmDeviceState;
  members: GroupMember[];
  notes: DeviceNote[];
  /** Detaching takes it out of the running guest now (worth a confirmation), rather than at the next stop. */
  liveDetach: boolean;
}

export interface VmDevicesView {
  running: boolean;
  firmware: 'uefi' | 'bios';
  devices: VmDevice[];
}

interface Entry {
  h: Hostdev;
  key: string;
  inConfig: boolean;
  inLive: boolean;
  /** The element as the running guest has it, for an exact live detach. */
  liveXml?: string;
}

export function entriesOf(vm: Pick<VmHostdevs, 'config' | 'live'>): Entry[] {
  const map = new Map<string, Entry>();
  for (const h of vm.config) map.set(hostdevKey(h), { h, key: hostdevKey(h), inConfig: true, inLive: false });
  for (const h of vm.live) {
    let key = hostdevKey(h);
    let e = map.get(key);
    if (!e && h.type === 'usb') {
      // libvirt writes the bus and device number it found into the running
      // definition, while the saved one may match by vendor and product only.
      const byIds = hostdevKey({ ...h, bus: undefined, device: undefined });
      if (map.get(byIds)?.inConfig) {
        key = byIds;
        e = map.get(byIds);
      }
    }
    if (e) {
      e.inLive = true;
      e.liveXml = h.xml;
    } else {
      map.set(key, { h, key, inConfig: false, inLive: true, liveXml: h.xml });
    }
  }
  return [...map.values()];
}

function findUsb(facts: HostFacts, h: Extract<Hostdev, { type: 'usb' }>) {
  return facts.usb.find((u) => u.vendorId === h.vendorId && u.productId === h.productId
    && (h.bus === undefined || h.device === undefined || (u.busnum === h.bus && u.devnum === h.device)));
}

function stateOf(e: Entry, running: boolean, present: boolean): VmDeviceState {
  if (!present && !e.inLive) return 'missing';
  if (!running) return 'attached';
  if (e.inConfig && e.inLive) return 'attached';
  return e.inConfig ? 'pending-attach' : 'pending-detach';
}

const STATE_NOTES: Partial<Record<VmDeviceState, DeviceNote>> = {
  'pending-attach': { tone: 'info', text: 'Joins when the VM next starts.' },
  'pending-detach': { tone: 'info', text: 'Leaves when the VM next stops.' },
  missing: { tone: 'warn', text: "Not on this host any more. The VM won't start until it is detached." },
};

export async function getVmDevices(uuid: string): Promise<VmDevicesView> {
  const [vm, facts] = await Promise.all([getVm(uuid), getHostFacts()]);
  const firmware = domainFirmware(vm.configXml);
  const host = evaluateHost(facts);
  const byAddress = new Map(facts.pci.map((d) => [d.address, d]));
  const entries = entriesOf(vm);
  const devices: VmDevice[] = [];

  // PCI: one row per IOMMU group, led by its most significant device.
  const units = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.h.type !== 'pci') continue;
    const d = byAddress.get(e.h.address);
    const unit = d?.iommuGroup !== undefined ? `g${d.iommuGroup}` : `a${e.h.address}`;
    units.set(unit, [...(units.get(unit) ?? []), e]);
  }
  for (const list of units.values()) {
    const ranked = list.map((e) => {
      const d = byAddress.get((e.h as Extract<Hostdev, { type: 'pci' }>).address);
      const c = d ? classifyPci(d) : undefined;
      const rank = c?.offer ? KIND_ORDER.indexOf(c.kind) : KIND_ORDER.length;
      return { e, d, c, rank };
    }).sort((a, b) => a.rank - b.rank);
    const lead = ranked[0];
    const address = (lead.e.h as Extract<Hostdev, { type: 'pci' }>).address;
    const present = !!lead.d;
    const state = stateOf(lead.e, vm.running, present);
    const notes: DeviceNote[] = [];
    const stateNote = STATE_NOTES[state];
    if (stateNote) notes.push(stateNote);
    if (present && !host.pciReady) {
      notes.push({ tone: 'warn', text: `The VM can't start with it until passthrough works on this host. ${host.blocker ?? ''}`.trim() });
    }
    const bar = lead.d?.memoryBars.length ? Math.max(...lead.d.memoryBars) : 0;
    if (bar >= UEFI_ONLY_BAR && firmware === 'bios') {
      notes.push({ tone: 'warn', text: `It has a ${formatBarSize(bar)} memory window, which BIOS firmware can't place: the VM stops as soon as it starts. Use it with a VM that boots with UEFI firmware.` });
    }
    devices.push({
      key: lead.e.key,
      keys: ranked.map((r) => r.e.key),
      type: 'pci',
      name: lead.d ? pciName(lead.d) : 'Unknown device',
      vendor: lead.d ? pciVendor(lead.d) : 'Not on this host',
      kindLabel: lead.c?.label ?? 'PCI device',
      address,
      state,
      members: ranked.slice(1).map((r) => ({
        address: (r.e.h as Extract<Hostdev, { type: 'pci' }>).address,
        name: r.d ? pciName(r.d) : 'Unknown device',
        kindLabel: r.c?.label ?? 'PCI device',
        driver: r.d?.driver,
      })),
      notes,
      // The same rule detachDevice applies: one non-display device leaves a running guest at once.
      liveDetach: vm.running && lead.e.inLive && ranked.length === 1 && !(lead.c?.offer && lead.c.kind === 'gpu'),
    });
  }

  for (const e of entries) {
    if (e.h.type !== 'usb') continue;
    const u = findUsb(facts, e.h);
    const state = stateOf(e, vm.running, !!u);
    const stateNote = STATE_NOTES[state];
    devices.push({
      key: e.key,
      keys: [e.key],
      type: 'usb',
      name: u?.product ?? `USB device ${e.h.vendorId ?? '????'}:${e.h.productId ?? '????'}`,
      vendor: u?.manufacturer ?? (u ? '' : 'Not plugged in'),
      kindLabel: 'USB device',
      address: u ? `Bus ${String(u.busnum).padStart(3, '0')} Device ${String(u.devnum).padStart(3, '0')}` : `${e.h.vendorId}:${e.h.productId}`,
      state,
      members: [],
      liveDetach: vm.running && e.inLive,
      notes: stateNote ? [state === 'missing'
        ? { tone: 'warn', text: "It isn't plugged in. The VM won't start until it is plugged in or detached." }
        : stateNote] : [],
    });
  }

  return { running: vm.running, firmware, devices };
}

// ─── Attach / detach ──────────────────────────────────────────────────────────

export interface ChangeResult {
  /** 'now': the running guest has it (or no longer has it); 'next-start'/'next-stop': the saved configuration does. */
  applied: 'now' | 'next-start' | 'next-stop';
  /** Why a running VM didn't take the change straight away. */
  reason?: string;
}

async function withXmlFile<T>(xml: string, fn: (file: string) => Promise<T>): Promise<T> {
  const file = path.join(os.tmpdir(), `vp-device-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  await fs.writeFile(file, xml, 'utf8');
  try {
    return await fn(file);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

async function changeDevice(op: 'attach-device' | 'detach-device', uuid: string, xml: string, where: '--config' | '--live', trace?: TraceEntry[]) {
  await withXmlFile(xml, (file) => virsh([op, uuid, file, where], trace));
}

function friendly(err: unknown, facts?: HostFacts): string {
  const raw = String((err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : err));
  return translatePassthroughError(raw, facts) ?? virshMessage(raw);
}

export function attachDevice(uuid: string, deviceId: string, trace?: TraceEntry[]): Promise<ChangeResult> {
  return serialized(() => attachDeviceNow(uuid, deviceId, trace));
}

async function attachDeviceNow(uuid: string, deviceId: string, trace?: TraceEntry[]): Promise<ChangeResult> {
  const vm = await getVm(uuid);
  const inventory = await getDeviceInventory(true);
  const facts = await getHostFacts();
  const dev = inventory.devices.find((d) => d.id === deviceId);
  if (!dev) {
    const hidden = inventory.hidden.find((h) => h.id === deviceId);
    if (hidden) throw new DeviceError(`${hidden.name} can't be passed through: ${hidden.reason.charAt(0).toLowerCase()}${hidden.reason.slice(1)}.`);
    throw new DeviceError('That device is not on this host any more. Refresh the list and try again.', 404);
  }
  if (dev.usedBy.some((v) => v.uuid === vm.uuid)) throw new DeviceError(`${dev.name} is already attached to this VM.`, 409);
  const other = dev.usedBy.find((v) => v.uuid !== vm.uuid);
  if (other) throw new DeviceError(`${dev.name} is already given to ${other.name}. Detach it there first.`, 409);

  if (dev.type === 'pci') return attachPci(vm, dev, inventory, facts, trace);
  return attachUsb(vm, dev, facts, trace);
}

async function attachPci(vm: VmHostdevs, dev: PassthroughDevice, inventory: DeviceInventory, facts: HostFacts, trace?: TraceEntry[]): Promise<ChangeResult> {
  if (!inventory.host.pciReady) {
    throw new DeviceError(`PCI passthrough isn't available on this host yet. ${inventory.host.blocker ?? ''}`.trim());
  }
  if ((dev.largestBar ?? 0) >= UEFI_ONLY_BAR && domainFirmware(vm.configXml) === 'bios') {
    throw new DeviceError(`${dev.name} has a ${formatBarSize(dev.largestBar!)} memory window, which BIOS firmware can't place: ` +
      'the VM would stop as soon as it started. Use it with a VM that boots with UEFI firmware.');
  }
  const addresses = [dev.address, ...dev.members.map((m) => m.address)];
  const xmls = addresses.map(buildPciHostdevXml);

  // The saved configuration first: if that fails nothing has changed, and if
  // the live attach fails afterwards the device still joins at the next start.
  const done: string[] = [];
  try {
    for (const xml of xmls) {
      await changeDevice('attach-device', vm.uuid, xml, '--config', trace);
      done.push(xml);
    }
  } catch (err) {
    for (const xml of done) await changeDevice('detach-device', vm.uuid, xml, '--config').catch(() => {});
    throw new DeviceError(friendly(err, facts));
  }

  if (!vm.running) return { applied: 'now' };
  if (dev.kind === 'gpu') {
    return { applied: 'next-start', reason: 'A graphics card joins when the VM next starts: running guests rarely take one cleanly.' };
  }
  if (xmls.length > 1) {
    return { applied: 'next-start', reason: 'Devices that share an isolation group join together when the VM next starts.' };
  }
  try {
    await changeDevice('attach-device', vm.uuid, xmls[0], '--live', trace);
    return { applied: 'now' };
  } catch (err) {
    const why = friendly(err, facts);
    return { applied: 'next-start', reason: /no free slot/.test(why) ? `${why} It joins when the VM next starts.` : `The running guest didn't take it (${why}). It joins when the VM next starts.` };
  }
}

async function attachUsb(vm: VmHostdevs, dev: PassthroughDevice, facts: HostFacts, trace?: TraceEntry[]): Promise<ChangeResult> {
  const port = portFromUsbId(dev.id);
  const u = facts.usb.find((x) => x.port === port);
  if (!u) throw new DeviceError('That USB device has been unplugged. Refresh the list and try again.', 404);
  const xml = buildUsbHostdevXml(u.vendorId, u.productId, dev.byAddress ? { bus: u.busnum, device: u.devnum } : undefined);
  try {
    await changeDevice('attach-device', vm.uuid, xml, '--config', trace);
  } catch (err) {
    throw new DeviceError(friendly(err, facts));
  }
  if (!vm.running) return { applied: 'now' };
  try {
    await changeDevice('attach-device', vm.uuid, xml, '--live', trace);
    return { applied: 'now' };
  } catch (err) {
    return { applied: 'next-start', reason: `The running guest didn't take it (${friendly(err, facts)}). It joins when the VM next starts.` };
  }
}

export function detachDevice(uuid: string, key: string, trace?: TraceEntry[]): Promise<ChangeResult> {
  return serialized(() => detachDeviceNow(uuid, key, trace));
}

async function detachDeviceNow(uuid: string, key: string, trace?: TraceEntry[]): Promise<ChangeResult> {
  const [vm, facts] = await Promise.all([getVm(uuid), getHostFacts(true)]);
  const entries = entriesOf(vm);
  const target = entries.find((e) => e.key === key);
  if (!target) throw new DeviceError('That device is not attached to this VM.', 404);

  // A PCI device leaves with the rest of its isolation group.
  let leaving = [target];
  let display = false;
  if (target.h.type === 'pci') {
    const byAddress = new Map(facts.pci.map((d) => [d.address, d]));
    const group = byAddress.get(target.h.address)?.iommuGroup;
    if (group !== undefined) {
      leaving = entries.filter((e) => e.h.type === 'pci' && byAddress.get(e.h.address)?.iommuGroup === group);
    }
    display = leaving.some((e) => {
      const d = e.h.type === 'pci' ? byAddress.get(e.h.address) : undefined;
      return !!d && kindOf(d) === 'gpu';
    });
  }

  let applied: ChangeResult['applied'] = 'now';
  let reason: string | undefined;
  for (const e of leaving) {
    if (e.inConfig) {
      try {
        await changeDevice('detach-device', vm.uuid, e.h.xml, '--config', trace);
      } catch (err) {
        throw new DeviceError(friendly(err, facts));
      }
    }
  }
  if (vm.running) {
    const live = leaving.filter((e) => e.inLive);
    if (live.length && (display || live.length > 1)) {
      applied = 'next-stop';
      reason = display
        ? 'A graphics card stays with the running guest until it stops: pulling one from a running guest can hang it.'
        : 'Devices that share an isolation group leave together when the VM next stops.';
    } else {
      for (const e of live) {
        const liveXml = e.liveXml ?? e.h.xml;
        try {
          await changeDevice('detach-device', vm.uuid, liveXml, '--live', trace);
        } catch (err) {
          applied = 'next-stop';
          reason = `The running guest didn't let go of it (${friendly(err, facts)}). It leaves when the VM next stops.`;
        }
      }
    }
  }
  return { applied, reason };
}

/**
 * Undo a detach that is waiting for the VM to stop: put the device (and the
 * rest of its isolation group) back in the saved configuration, from the copy
 * the running guest still has.
 */
export function keepAttached(uuid: string, key: string, trace?: TraceEntry[]): Promise<ChangeResult> {
  return serialized(() => keepAttachedNow(uuid, key, trace));
}

async function keepAttachedNow(uuid: string, key: string, trace?: TraceEntry[]): Promise<ChangeResult> {
  const [vm, facts] = await Promise.all([getVm(uuid), getHostFacts(true)]);
  const entries = entriesOf(vm);
  const target = entries.find((e) => e.key === key);
  if (!target || target.inConfig || !target.inLive) {
    throw new DeviceError('That device is not leaving this VM, so there is nothing to undo.', 404);
  }
  let staying = [target];
  if (target.h.type === 'pci') {
    const group = facts.pci.find((d) => d.address === (target.h as Extract<Hostdev, { type: 'pci' }>).address)?.iommuGroup;
    if (group !== undefined) {
      staying = entries.filter((e) => e.inLive && !e.inConfig && e.h.type === 'pci'
        && facts.pci.find((d) => d.address === (e.h as Extract<Hostdev, { type: 'pci' }>).address)?.iommuGroup === group);
    }
  }
  for (const e of staying) {
    // The running copy carries libvirt's own alias, which a saved definition refuses
    // ("user aliases must start with ua-"); a USB device goes back by its IDs, as it was attached.
    const xml = e.h.type === 'usb' && e.h.vendorId && e.h.productId
      ? buildUsbHostdevXml(e.h.vendorId, e.h.productId)
      : (e.liveXml ?? e.h.xml).replace(/[ \t]*<alias\b[^>]*\/>\n?/g, '');
    try {
      await changeDevice('attach-device', vm.uuid, xml, '--config', trace);
    } catch (err) {
      throw new DeviceError(friendly(err, facts));
    }
  }
  return { applied: 'now' };
}

// ─── Before a start ───────────────────────────────────────────────────────────

/**
 * Every reason VFIO or libvirt would refuse to start this VM because of its
 * passed-through devices, found before trying, in words. Resolves when there
 * is nothing in the way.
 */
export async function checkBeforeStart(uuid: string): Promise<void> {
  const vm = await getVm(uuid);
  if (!vm.config.length) return;
  const [facts, vms] = await Promise.all([getHostFacts(true), listVmHostdevs()]);
  const pci = vm.config.filter((h): h is Extract<Hostdev, { type: 'pci' }> => h.type === 'pci');
  const usb = vm.config.filter((h): h is Extract<Hostdev, { type: 'usb' }> => h.type === 'usb');
  const byAddress = new Map(facts.pci.map((d) => [d.address, d]));
  const label = (address: string) => {
    const d = byAddress.get(address);
    return d ? `${cleanName(d.deviceName, 'Device')} (${address.replace(/^0000:/, '')})` : address.replace(/^0000:/, '');
  };

  if (pci.length) {
    const host = evaluateHost(facts);
    if (!host.pciReady) {
      throw new DeviceError([
        `${vm.name} has PCI devices passed through, and passthrough doesn't work on this host yet.`,
        host.blocker,
        'Detach them on the Devices tab to start it without them.',
      ].filter(Boolean).join(' '), 409);
    }
    const missing = pci.filter((h) => !byAddress.has(h.address));
    if (missing.length) {
      throw new DeviceError(`${vm.name} was given ${missing.map((h) => `PCI device ${h.address.replace(/^0000:/, '')}`).join(' and ')}, ` +
        "which isn't on this host any more. Detach it on the Devices tab to start the VM.", 409);
    }
    if (domainFirmware(vm.configXml) === 'bios') {
      const big = pci.find((h) => Math.max(0, ...(byAddress.get(h.address)?.memoryBars ?? [])) >= UEFI_ONLY_BAR);
      if (big) {
        const bar = Math.max(...byAddress.get(big.address)!.memoryBars);
        throw new DeviceError(`${label(big.address)} has a ${formatBarSize(bar)} memory window, which BIOS firmware can't place: ` +
          'the VM would stop as soon as it started. Use it with a VM that boots with UEFI firmware.', 409);
      }
    }
    const mine = new Set(pci.map((h) => h.address));
    for (const h of pci) {
      const group = byAddress.get(h.address)?.iommuGroup;
      const blockers = facts.pci.filter((d) => d.iommuGroup === group && !mine.has(d.address) && !d.isBridge
        && d.driver && d.driver !== 'vfio-pci' && d.driver !== 'pci-stub');
      if (blockers.length) {
        throw new DeviceError(`${label(h.address)} shares an isolation group with ${blockers.map((b) => `${label(b.address)}, driver ${b.driver}`).join('; ')}, ` +
          'which the host is still using, so VFIO would refuse it. Detach the device and attach it again: VirtPilot then brings the whole group.', 409);
      }
    }
    for (const other of vms) {
      if (other.uuid === vm.uuid || !other.running) continue;
      const clash = other.live.find((h) => h.type === 'pci' && mine.has(h.address));
      if (clash && clash.type === 'pci') {
        throw new DeviceError(`${label(clash.address)} is in use by ${other.name}, which is running. Stop ${other.name} first.`, 409);
      }
    }
    // Locked memory must exist. A hugepage-backed guest draws on the hugepage pool,
    // which MemAvailable leaves out; anyone else can also have what the ZFS ARC
    // gives back under pressure. Only a start that can't fit is refused.
    const memKib = domainMemoryKib(vm.configXml) ?? 0;
    const hugepages = /<memoryBacking>[\s\S]*?<hugepages\b[\s\S]*?<\/memoryBacking>/.test(vm.configXml);
    const freeKib = hugepages ? facts.hugepagesFreeKb : facts.memAvailableKb + facts.zfsArcReclaimableKb;
    if (freeKib > 0 && memKib > freeKib) {
      const gb = (kib: number) => `${Math.round((kib / 1024 ** 2) * 10) / 10} GB`;
      throw new DeviceError(`${vm.name} needs ${gb(memKib)} of free ${hugepages ? 'hugepage ' : 'host '}memory: with PCI devices passed through, ` +
        `all of its memory stays locked on the host. ${gb(freeKib)} is free.`, 409);
    }
  }

  for (const h of usb) {
    if (!findUsb(facts, h)) {
      throw new DeviceError(`USB device ${h.vendorId}:${h.productId} isn't plugged in. Plug it in, or detach it on the Devices tab, then start ${vm.name}.`, 409);
    }
  }
}

/** A start that failed: say why in words when it was the passthrough that stopped it. */
export async function explainStartFailure(err: unknown): Promise<string | null> {
  const raw = String((err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : err));
  const facts = await getHostFacts().catch(() => undefined);
  return translatePassthroughError(raw, facts);
}

/** True when the VM's saved configuration passes a PCI device through. */
export async function hasPciPassthrough(uuid: string): Promise<boolean> {
  try {
    const xml = await virsh(['dumpxml', '--inactive', validateVmName(uuid)]);
    return parseHostdevs(xml).some((h) => h.type === 'pci');
  } catch {
    return false;
  }
}

// ─── Host settings (root helper) ──────────────────────────────────────────────

const PCI_ADDRESS_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/;

async function runHelper(args: string[], trace?: TraceEntry[]): Promise<string> {
  if (!(await helperAvailable())) {
    throw new DeviceError('This needs the passthrough helper that the installer adds. Run update.sh (or install.sh) again to add it.', 501);
  }
  // Through systemd-run, not plain sudo: virtpilot.service runs with
  // ProtectKernelTunables, which makes /sys read-only for everything it
  // starts, sudo included. A transient unit runs outside that sandbox.
  try {
    return await sudo('systemd-run', [
      '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec',
      `--unit=virtpilot-passthrough-${process.pid}-${Date.now()}`,
      HELPER, ...args,
    ], { timeout: 120_000, trace });
  } catch (err) {
    const raw = String((err as { stderr?: string })?.stderr || (err instanceof Error ? err.message : err));
    throw new DeviceError(raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? 'The passthrough helper failed.');
  }
}

/** Bind a device to vfio-pci now and from every boot, so the host never drives it. */
export function keepForVms(deviceId: string, keep: boolean, trace?: TraceEntry[]): Promise<void> {
  return serialized(() => keepForVmsNow(deviceId, keep, trace));
}

async function keepForVmsNow(deviceId: string, keep: boolean, trace?: TraceEntry[]): Promise<void> {
  const inventory = await getDeviceInventory(true);
  const dev = inventory.devices.find((d) => d.id === deviceId && d.type === 'pci');
  if (!dev) throw new DeviceError('That device can\'t be kept for VMs: it is not one that can be passed through.', 404);
  if (!inventory.host.pciReady) throw new DeviceError(`PCI passthrough isn't available on this host yet. ${inventory.host.blocker ?? ''}`.trim());
  // Either way, not while a VM runs with it: libvirt gives a device back to the driver it
  // found at the VM's start, so a keep made now would be undone the moment the VM stops.
  const busy = dev.usedBy.find((v) => v.running);
  if (busy) {
    throw new DeviceError(keep
      ? `${busy.name} is using it. Stop ${busy.name} first, then keep it for VMs.`
      : `${busy.name} is using it. Stop ${busy.name} first, then the host can take it back.`, 409);
  }
  const addresses = [dev.address, ...dev.members.map((m) => m.address)];
  for (const a of addresses) {
    if (!PCI_ADDRESS_RE.test(a)) throw new DeviceError('Invalid PCI address');
    await runHelper([keep ? 'keep' : 'release', a], trace);
  }
}

/** Switch a card's SR-IOV virtual functions to `count` now and at every boot. */
export function setVirtualFunctions(deviceId: string, count: number, trace?: TraceEntry[]): Promise<void> {
  return serialized(() => setVirtualFunctionsNow(deviceId, count, trace));
}

async function setVirtualFunctionsNow(deviceId: string, count: number, trace?: TraceEntry[]): Promise<void> {
  const inventory = await getDeviceInventory(true);
  const dev = inventory.devices.find((d) => d.id === deviceId && d.type === 'pci');
  if (!dev?.sriov) throw new DeviceError('That card has no virtual functions to switch on.', 404);
  if (!Number.isInteger(count) || count < 0 || count > dev.sriov.total) {
    throw new DeviceError(`Choose between 0 and ${dev.sriov.total} virtual functions.`);
  }
  if (dev.usedBy.length) throw new DeviceError(`The card itself is given to ${dev.usedBy[0].name}. Detach it there first.`, 409);
  // The kernel only changes the count by going through zero, so every
  // existing virtual function disappears and comes back: none may be in use.
  const vfs = inventory.devices.filter((d) => d.vfOf === dev.address && d.usedBy.length);
  if (vfs.length) {
    throw new DeviceError(`${vfs.length === 1 ? 'A virtual function of this card is' : 'Virtual functions of this card are'} given to ${vfs[0].usedBy[0].name}. Detach ${vfs.length === 1 ? 'it' : 'them'} first.`, 409);
  }
  await runHelper(['vfs', dev.address, String(count)], trace);
}
