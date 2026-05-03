import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { HostDevice } from '../types.js';
import { type TraceEntry } from './traceService.js';
import { virsh as safeVirsh } from './safeExec.js';
import { listVmsRaw } from './vmService.js';
import { validateVmName } from '../lib/validate.js';

async function virsh(args: readonly string[], trace?: TraceEntry[], timeout = 60_000): Promise<string> {
  return safeVirsh(args, { timeout, trace });
}

// nodedev names are returned by libvirt itself (pci_0000_01_00_0,
// usb_001_002, etc) — alphanumeric + underscore only. Validate before
// passing back into argv.
function validateNodedevName(s: string): string {
  if (!/^[a-zA-Z0-9_]{1,128}$/.test(s)) throw new Error('Invalid nodedev name');
  return s;
}

// ─── XML parsers ──────────────────────────────────────────────────────────────

// PCI class prefixes (first 2 hex chars of the 6-char class code) that are
// meaningful passthrough targets. Everything else — bridges, processor
// sub-functions, memory controllers, system peripherals — is filtered out.
const PASSTHROUGH_CLASSES = new Set([
  '01', // Storage (NVMe, SATA, RAID)
  '02', // Network
  '03', // Display / GPU
  '04', // Multimedia (audio, video capture)
  '09', // Input devices
  '0c', // Serial Bus (USB controllers, FireWire, Thunderbolt)
  '0d', // Wireless
  '10', // Encryption / crypto accelerators
  '11', // Signal processing (DSPs, FPGAs)
]);

function parsePciXml(xml: string): Omit<HostDevice, 'assignedTo'> | null {
  const nameMatch = xml.match(/<name>(pci_[^<]+)<\/name>/);
  if (!nameMatch) return null;

  const vendorMatch = xml.match(/<vendor id='([^']+)'>([^<]+)<\/vendor>/);
  const productMatch = xml.match(/<product id='([^']+)'>([^<]+)<\/product>/);
  const driverMatch = xml.match(/<driver>\s*<name>([^<]+)<\/name>\s*<\/driver>/);
  const iommuMatch = xml.match(/iommuGroup number='(\d+)'/);
  const domainMatch = xml.match(/<domain>(\d+)<\/domain>/);
  const busMatch = xml.match(/<bus>(\d+)<\/bus>/);
  const slotMatch = xml.match(/<slot>(\d+)<\/slot>/);
  const funcMatch = xml.match(/<function>(\d+)<\/function>/);
  const classMatch = xml.match(/<class>0x([0-9a-fA-F]+)<\/class>/);
  if (!classMatch || !PASSTHROUGH_CLASSES.has(classMatch[1].slice(0, 2).toLowerCase())) return null;

  return {
    id: nameMatch[1],
    type: 'pci',
    vendor: vendorMatch?.[2]?.trim() ?? 'Unknown',
    vendorId: vendorMatch?.[1] ?? '0x0000',
    product: productMatch?.[2]?.trim() ?? 'Unknown device',
    productId: productMatch?.[1] ?? '0x0000',
    driver: driverMatch?.[1]?.trim(),
    iommuGroup: iommuMatch ? parseInt(iommuMatch[1]) : undefined,
    pciClass: classMatch?.[1],
    pciAddress: {
      domain: domainMatch ? parseInt(domainMatch[1]) : 0,
      bus: busMatch ? parseInt(busMatch[1]) : 0,
      slot: slotMatch ? parseInt(slotMatch[1]) : 0,
      function: funcMatch ? parseInt(funcMatch[1]) : 0,
    },
  };
}

function parseUsbXml(xml: string): Omit<HostDevice, 'assignedTo'> | null {
  const nameMatch = xml.match(/<name>(usb_[^<]+)<\/name>/);
  if (!nameMatch) return null;

  const vendorMatch = xml.match(/<vendor id='([^']+)'>([^<]+)<\/vendor>/);
  const productMatch = xml.match(/<product id='([^']+)'>([^<]+)<\/product>/);
  // Devices with no product string are root hubs / host controllers — skip them
  if (!productMatch) return null;

  const busMatch = xml.match(/<bus>(\d+)<\/bus>/);
  const deviceMatch = xml.match(/<device>(\d+)<\/device>/);

  return {
    id: nameMatch[1],
    type: 'usb',
    vendor: vendorMatch?.[2]?.trim() ?? 'Unknown',
    vendorId: vendorMatch?.[1] ?? '0x0000',
    product: productMatch[2].trim(),
    productId: productMatch[1],
    usbAddress: {
      bus: busMatch ? parseInt(busMatch[1]) : 0,
      device: deviceMatch ? parseInt(deviceMatch[1]) : 0,
    },
  };
}

// ─── Assignment map ───────────────────────────────────────────────────────────

// Reconstruct nodedev PCI ID from hex address values as stored in VM XML.
// e.g. domain=0, bus=1, slot=0, fn=0 → 'pci_0000_01_00_0'
function pciAddressToId(domain: number, bus: number, slot: number, fn: number): string {
  return `pci_${domain.toString(16).padStart(4, '0')}_${bus.toString(16).padStart(2, '0')}_${slot.toString(16).padStart(2, '0')}_${fn.toString(16)}`;
}

// Key used to match USB devices via vendor+product (since USB hostdevs don't store bus/device)
function usbKey(vendorId: string, productId: string): string {
  return `usb:${vendorId}:${productId}`;
}

async function buildAssignmentMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  let vms: { name: string }[] = [];
  try {
    vms = await listVmsRaw();
  } catch {
    return map;
  }

  await Promise.allSettled(
    vms.map(async ({ name }) => {
      let xml: string;
      try {
        xml = await virsh(['dumpxml', validateVmName(name)]);
      } catch {
        return;
      }

      // PCI hostdevs — match on source address (not the guest-side address)
      const pciRe = /<hostdev[^>]*type='pci'[^>]*>[\s\S]*?<\/hostdev>/g;
      let m: RegExpExecArray | null;
      while ((m = pciRe.exec(xml)) !== null) {
        const block = m[0];
        // The <source> block comes before the guest <address>, so match within it
        const srcBlock = block.match(/<source>([\s\S]*?)<\/source>/)?.[1] ?? '';
        const addrMatch = srcBlock.match(
          /domain='(0x[0-9a-fA-F]+)'[^>]*bus='(0x[0-9a-fA-F]+)'[^>]*slot='(0x[0-9a-fA-F]+)'[^>]*function='(0x[0-9a-fA-F]+)'/,
        );
        if (addrMatch) {
          const id = pciAddressToId(
            parseInt(addrMatch[1], 16),
            parseInt(addrMatch[2], 16),
            parseInt(addrMatch[3], 16),
            parseInt(addrMatch[4], 16),
          );
          map.set(id, name);
        }
      }

      // USB hostdevs — match on vendor+product
      const usbRe = /<hostdev[^>]*type='usb'[^>]*>[\s\S]*?<\/hostdev>/g;
      while ((m = usbRe.exec(xml)) !== null) {
        const block = m[0];
        const srcBlock = block.match(/<source>([\s\S]*?)<\/source>/)?.[1] ?? '';
        const vendorMatch = srcBlock.match(/<vendor id='([^']+)'/);
        const productMatch = srcBlock.match(/<product id='([^']+)'/);
        if (vendorMatch && productMatch) {
          map.set(usbKey(vendorMatch[1], productMatch[1]), name);
        }
      }
    }),
  );

  return map;
}

// ─── Public API — enumeration ─────────────────────────────────────────────────

export async function listHostDevices(): Promise<HostDevice[]> {
  const [pciNames, usbNames, assignmentMap] = await Promise.all([
    virsh(['nodedev-list', '--cap', 'pci'])
      .then((o) => o.split('\n').filter(Boolean))
      .catch(() => [] as string[]),
    virsh(['nodedev-list', '--cap', 'usb_device'])
      .then((o) => o.split('\n').filter(Boolean))
      .catch(() => [] as string[]),
    buildAssignmentMap(),
  ]);

  const [pciResults, usbResults] = await Promise.all([
    Promise.allSettled(pciNames.map((n) => virsh(['nodedev-dumpxml', validateNodedevName(n)]).then(parsePciXml))),
    Promise.allSettled(usbNames.map((n) => virsh(['nodedev-dumpxml', validateNodedevName(n)]).then(parseUsbXml))),
  ]);

  const devices: HostDevice[] = [];

  for (const r of pciResults) {
    if (r.status === 'fulfilled' && r.value) {
      const d = r.value;
      devices.push({ ...d, assignedTo: assignmentMap.get(d.id) });
    }
  }

  for (const r of usbResults) {
    if (r.status === 'fulfilled' && r.value) {
      const d = r.value;
      devices.push({ ...d, assignedTo: assignmentMap.get(usbKey(d.vendorId, d.productId)) });
    }
  }

  return devices;
}

// ─── XML builders ─────────────────────────────────────────────────────────────

function buildPciHostdevXml(device: HostDevice): string {
  const a = device.pciAddress!;
  const domain = `0x${a.domain.toString(16).padStart(4, '0')}`;
  const bus = `0x${a.bus.toString(16).padStart(2, '0')}`;
  const slot = `0x${a.slot.toString(16).padStart(2, '0')}`;
  const fn = `0x${a.function.toString(16)}`;
  return `<hostdev mode='subsystem' type='pci' managed='yes'>
  <driver name='vfio'/>
  <source>
    <address domain='${domain}' bus='${bus}' slot='${slot}' function='${fn}'/>
  </source>
</hostdev>`;
}

function buildUsbHostdevXml(device: HostDevice): string {
  return `<hostdev mode='subsystem' type='usb' managed='yes'>
  <source>
    <vendor id='${device.vendorId}'/>
    <product id='${device.productId}'/>
  </source>
</hostdev>`;
}

// ─── Public API — attach / detach ────────────────────────────────────────────

export async function attachDevice(vmName: string, deviceId: string, trace?: TraceEntry[]): Promise<void> {
  const all = await listHostDevices();
  const device = all.find((d) => d.id === deviceId);
  if (!device) throw new Error(`Device '${deviceId}' not found on this host`);
  if (device.assignedTo) {
    throw new Error(`Device is already assigned to VM '${device.assignedTo}'`);
  }

  const safeVmName = validateVmName(vmName);
  const xml = device.type === 'pci' ? buildPciHostdevXml(device) : buildUsbHostdevXml(device);
  const tmpFile = path.join(os.tmpdir(), `vp-device-${Date.now()}.xml`);
  try {
    await fs.writeFile(tmpFile, xml, 'utf-8');
    await virsh(['attach-device', safeVmName, tmpFile, '--persistent'], trace);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

export async function detachDevice(vmName: string, deviceId: string, trace?: TraceEntry[]): Promise<void> {
  const all = await listHostDevices();
  const device = all.find((d) => d.id === deviceId);
  if (!device) throw new Error(`Device '${deviceId}' not found on this host`);

  const safeVmName = validateVmName(vmName);
  const xml = device.type === 'pci' ? buildPciHostdevXml(device) : buildUsbHostdevXml(device);
  const tmpFile = path.join(os.tmpdir(), `vp-device-${Date.now()}.xml`);
  try {
    await fs.writeFile(tmpFile, xml, 'utf-8');
    await virsh(['detach-device', safeVmName, tmpFile, '--persistent'], trace);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}
