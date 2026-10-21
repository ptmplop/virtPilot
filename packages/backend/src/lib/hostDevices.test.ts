import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  addressFromPciId, buildInventory, classifyPci, evaluateHost, findHostUse, mountSummary, pciId, portFromUsbId,
  type AssignmentIndex,
} from './hostDevices.js';
import type { HostFacts, PciFacts } from './hostFacts.js';

// Snapshots of a real two-socket Xeon (Intel S2600BP) with an NVIDIA L4, a
// BlueField-3 and an X550, captured by services/hostScan.ts under the
// service's own sandbox, before and after VT-x/VT-d were switched on.
const load = (name: string): HostFacts => JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'));
const none: AssignmentIndex = { pci: new Map(), usb: new Map() };

function pci(over: Partial<PciFacts> & { address: string; classCode: string }): PciFacts {
  return { vendorId: '1234', deviceId: '0001', memoryBars: [4096], isBridge: false, ...over };
}

function host(over: Partial<HostFacts> = {}): HostFacts {
  return {
    kernel: '6.8.0-test', cpu: { vendor: 'intel', model: 'Test CPU', vmx: true, svm: false }, kvm: true,
    acpi: { dmar: true, ivrs: false }, iommuGroups: 10, cmdline: 'ro quiet', journal: [], irqRemapping: true,
    allowUnsafeInterrupts: false, vfioPci: 'available', pci: [], usb: [], block: [], net: [], drm: [], memAvailableKb: 8 * 1024 ** 2,
    hugepagesFreeKb: 0, zfsArcReclaimableKb: 0,
    ...over,
  };
}

describe('the bp8 snapshot with VT-x and VT-d on', () => {
  const facts = load('bp8-vt-on.json');
  const inv = buildInventory({ facts, assignments: none });

  it('offers the cards a VM can use, and nothing else', () => {
    expect(inv.devices.map((d) => `${d.kindLabel} ${d.address}`)).toEqual([
      'GPU 0000:3b:00.0',
      'Network card 0000:18:00.1',
      'Network card 0000:5e:00.0',
      'SATA controller 0000:00:11.5',
      'SATA controller 0000:00:17.0',
      'SAS controller 0000:d8:00.0',
      'USB controller 0000:00:14.0',
      'DMA controller 0000:5e:00.1',
      'USB input device Bus 001 Device 003',
    ]);
    // 212 PCI functions and 4 USB devices: each one is offered, travels with a device that is
    // (the xHCI brings its group-mate), or is hidden with its reason. None goes missing.
    const members = inv.devices.reduce((n, d) => n + d.members.length, 0);
    expect(inv.devices.length + members + inv.hidden.length).toBe(facts.pci.length + facts.usb.length);
  });

  it("hides what the host is using and says what for", () => {
    const host = Object.fromEntries(inv.hidden.filter((h) => h.category === 'host').map((h) => [h.address, h.reason]));
    expect(host).toEqual({
      '0000:02:00.0': "Draws the host's screen (VGA-1)",
      '0000:18:00.0': "Carries the host's network (eth0, 203.0.113.78)",
      '0000:89:00.0': "Holds the host's disk nvme0n1 (/, /boot and /boot/efi)",
    });
  });

  it('hides chipset plumbing, bridges and hubs as such', () => {
    const counts: Record<string, number> = {};
    for (const h of inv.hidden) counts[h.category] = (counts[h.category] ?? 0) + 1;
    expect(counts).toEqual({ host: 3, chipset: 188, bridge: 12, hub: 3 });
    expect(inv.hidden.find((h) => h.address === '0000:00:05.4')?.reason).toBe('System peripheral, part of the chipset or processor');
  });

  it('brings a device\'s isolation group with it, and says what the host loses', () => {
    const xhci = inv.devices.find((d) => d.address === '0000:00:14.0')!;
    expect(xhci.members.map((m) => m.address)).toEqual(['0000:00:14.2']);
    expect(xhci.notes.map((n) => n.text)).toEqual([
      'Brings C620 Series Chipset Family Thermal Subsystem (00:14.2) with it: they share an isolation group, so they go to the same VM.',
      'The host loses what is plugged into it while a VM uses it: HID Gadget.',
    ]);
    // The sSATA controller's group-mates (MROM 0 and 1) have no driver, so they stay behind.
    expect(inv.devices.find((d) => d.address === '0000:00:11.5')!.members).toEqual([]);
  });

  it('describes a GPU by what matters for passthrough', () => {
    const l4 = inv.devices[0];
    // Named the way nvidia-smi and its owner name it; lspci's chip codename becomes a fact.
    expect(l4.name).toBe('NVIDIA L4');
    expect(l4.vendor).toBe('NVIDIA');
    expect(l4.largestBar).toBe(32 * 1024 ** 3);
    expect(l4.facts).toEqual(['AD104GL', '32 GB memory window', 'Resets cleanly', 'NUMA node 0']);
    // A GPU's SR-IOV functions need NVIDIA's own vGPU host driver, so they aren't offered.
    expect(l4.sriov).toBeUndefined();
    expect(inv.devices.find((d) => d.address === '0000:5e:00.0')!.sriov).toEqual({ total: 16, current: 0 });
  });

  it('passes every host check', () => {
    expect(inv.host.pciReady).toBe(true);
    expect(inv.host.checks.map((c) => `${c.label}: ${c.value}`)).toEqual([
      'Hardware virtualisation: On (Intel VT-x)',
      'IOMMU: On (Intel VT-d), 149 isolation groups',
      'Interrupt remapping: On',
      'VFIO driver: Loaded',
    ]);
  });

  it('marks devices given to a VM', () => {
    const vm = { uuid: 'fe2b519b-363d-40b4-847d-4f78a1751aaf', name: 'gpu-uefi', running: true };
    const withVm = buildInventory({ facts, assignments: { pci: new Map([['0000:3b:00.0', [vm]]]), usb: new Map() } });
    expect(withVm.devices[0].usedBy).toEqual([vm]);
  });
});

describe('the same host before VT-x and VT-d were switched on', () => {
  const inv = buildInventory({ facts: load('bp8-vt-off.json'), assignments: none });

  it('names the firmware settings to change', () => {
    expect(inv.host.pciReady).toBe(false);
    const [cpu, iommu, irq] = inv.host.checks;
    expect(cpu).toMatchObject({ state: 'off', value: 'Off in the firmware settings' });
    expect(cpu.fix).toBe('Turn on Intel Virtualization Technology (VT-x) in the firmware (BIOS/UEFI) setup, then restart the host.');
    expect(iommu).toMatchObject({ state: 'off', value: 'Off in the firmware settings' });
    expect(iommu.fix).toContain('Intel VT for Directed I/O (VT-d)');
    expect(irq.state).toBe('na');
    expect(inv.host.blocker).toBe('Hardware virtualisation: off in the firmware settings.');
  });

  it('still lists the USB device, which needs no IOMMU', () => {
    expect(inv.host.usbReady).toBe(true);
    expect(inv.devices.some((d) => d.type === 'usb')).toBe(true);
  });
});

describe('evaluateHost', () => {
  it('without the journal, does not claim the firmware switched VT-x off', () => {
    const h = evaluateHost(host({ kvm: false, cpu: { vendor: 'intel', model: 'x', vmx: false, svm: false }, journal: [] }));
    expect(h.checks[0].value).toBe('Off, or not available on this processor');
  });

  it('spots an IOMMU switched off on the kernel command line', () => {
    const h = evaluateHost(host({ iommuGroups: 0, cmdline: 'ro quiet amd_iommu=off', acpi: { dmar: false, ivrs: true }, cpu: { vendor: 'amd', model: 'x', vmx: false, svm: true } }));
    expect(h.checks[1].value).toBe('Switched off on the kernel command line (amd_iommu=off)');
    expect(h.checks[1].fix).toContain('Remove amd_iommu=off');
  });

  it('asks for intel_iommu=on when the table is there but the kernel left it off', () => {
    const h = evaluateHost(host({ iommuGroups: 0 }));
    expect(h.checks[1].value).toBe('Present but not switched on');
    expect(h.checks[1].fix).toContain('intel_iommu=on');
  });

  it("doesn't call vfio-pci missing when the sandbox can't see the modules", () => {
    const h = evaluateHost(host({ vfioPci: 'unknown' }));
    expect(h.checks[3]).toMatchObject({ state: 'ok', value: 'Loads when a VM needs it' });
    expect(h.pciReady).toBe(true);
  });

  it('flags missing interrupt remapping', () => {
    expect(evaluateHost(host({ irqRemapping: false })).checks[2].state).toBe('off');
    expect(evaluateHost(host({ irqRemapping: false, allowUnsafeInterrupts: true })).checks[2].state).toBe('warn');
    expect(evaluateHost(host({ irqRemapping: false, allowUnsafeInterrupts: true })).pciReady).toBe(true);
  });
});

describe('classifyPci', () => {
  const kind = (classCode: string, vendorId = '10de', memoryBars = [4096]) => {
    const c = classifyPci({ classCode, vendorId, memoryBars, isBridge: false });
    return c.offer ? c.label : `hidden: ${c.label}`;
  };

  it('names the devices people pass through', () => {
    expect(kind('030000')).toBe('Graphics card');
    expect(kind('030200')).toBe('GPU');
    expect(kind('010802', '144d')).toBe('NVMe drive');
    expect(kind('020000', '8086')).toBe('Network card');
    expect(kind('0c0330', '8086')).toBe('USB controller');
    expect(kind('040300', '8086')).toBe('Audio device');
    expect(kind('120000', '1e52')).toBe('Accelerator');
    expect(kind('0b4000', '8086')).toBe('Co-processor');
  });

  it('keeps chipset and CPU functions out', () => {
    expect(kind('088000', '8086')).toBe('hidden: System peripheral');
    expect(kind('110100', '8086', [])).toBe('hidden: Signal processing function');
    expect(kind('078000', '8086')).toBe('hidden: Management engine interface');
    expect(kind('0c0500', '8086')).toBe('hidden: SMBus controller');
    expect(kind('ff0000', '8086', [])).toBe('hidden: Platform function');
    expect(kind('060100', '8086', [])).toBe('hidden: Bridge');
  });

  it('offers a system device on someone else\'s card', () => {
    expect(kind('080100', '15b3', [8 << 20])).toBe('DMA controller');
  });
});

describe('isolation groups and the host', () => {
  it('never offers a group that would take the chipset\'s LPC bridge', () => {
    const facts = host({
      pci: [
        pci({ address: '0000:00:1f.0', classCode: '060100', vendorId: '8086', driver: 'lpc_ich', iommuGroup: 7, memoryBars: [] }),
        pci({ address: '0000:00:1f.3', classCode: '040300', vendorId: '8086', driver: 'snd_hda_intel', iommuGroup: 7 }),
      ],
    });
    const inv = buildInventory({ facts, assignments: none });
    expect(inv.devices).toEqual([]);
    expect(inv.hidden.find((h) => h.address === '0000:00:1f.3')?.reason)
      .toBe("Shares an isolation group with Device 8086:0001 (00:1f.0). It is the chipset's LPC bridge, which the host needs.");
  });

  it('hides a NIC under a bridge that carries the host address', () => {
    const facts = host({
      pci: [pci({ address: '0000:01:00.0', classCode: '020000', iommuGroup: 3 })],
      net: [
        { name: 'eno1', pci: '0000:01:00.0', addresses: [], uppers: ['br0'], upperAddresses: ['192.0.2.10/24'], feedsBridge: 'br0' },
        { name: 'br0', addresses: ['192.0.2.10/24'], uppers: [], upperAddresses: [], feedsBridge: 'br0' },
      ],
    });
    expect(findHostUse(facts).pci.get('0000:01:00.0')).toBe("Carries the host's network (eno1 under br0, 192.0.2.10)");
  });

  it('hides a NIC that only feeds a VM bridge', () => {
    const facts = host({
      net: [{ name: 'eno2', pci: '0000:02:00.0', addresses: [], uppers: ['br1'], upperAddresses: [], feedsBridge: 'br1' }],
    });
    expect(findHostUse(facts).pci.get('0000:02:00.0')).toBe('Connects the bridge br1 that VMs use (eno2)');
  });

  it('protects the USB controller holding a mounted USB disk', () => {
    const facts = host({
      pci: [pci({ address: '0000:00:14.0', classCode: '0c0330', vendorId: '8086', driver: 'xhci_hcd', iommuGroup: 9 })],
      usb: [{ port: '1-2', busnum: 1, devnum: 3, vendorId: '0781', productId: '5583', deviceClass: '00', interfaceClasses: ['08'], interfaceDrivers: ['usb-storage'], product: 'Ultra Fit', controller: '0000:00:14.0' }],
      block: [{ name: 'sdb', pci: '0000:00:14.0', usbPort: '1-2', uses: ['mounted at /srv/data'] }],
    });
    const inv = buildInventory({ facts, assignments: none });
    expect(inv.devices).toEqual([]);
    expect(inv.hidden.map((h) => h.reason)).toEqual([
      "The host's USB disk sdb is plugged into it (/srv/data)",
      "Holds the host's disk sdb (/srv/data)",
    ]);
  });

  it('gives one of two identical USB devices to a VM without taking the other', () => {
    const stick = { busnum: 1, vendorId: '1050', productId: '0407', deviceClass: '00', interfaceClasses: ['03'], interfaceDrivers: ['usbhid'], product: 'YubiKey' };
    const facts = host({ usb: [{ ...stick, port: '1-1', devnum: 4 }, { ...stick, port: '1-3', devnum: 5 }] });
    const vm = { uuid: 'u1', name: 'vm-a', running: true };
    const pinned = buildInventory({ facts, assignments: { pci: new Map(), usb: new Map([['1050:0407', [{ ...vm, bus: 1, device: 4 }]]]) } });
    expect(pinned.devices.map((d) => [d.id, d.usedBy.map((v) => v.name)])).toEqual([['usb_1-1', ['vm-a']], ['usb_1-3', []]]);
    // A hostdev by IDs alone matches whichever is plugged in, so it claims both.
    const loose = buildInventory({ facts, assignments: { pci: new Map(), usb: new Map([['1050:0407', [vm]]]) } });
    expect(loose.devices.every((d) => d.usedBy.length === 1)).toBe(true);
  });

  it('protects every controller of a multipath NVMe namespace', () => {
    const facts = host({
      pci: [
        pci({ address: '0000:3d:00.0', classCode: '010802', vendorId: '144d', driver: 'nvme', iommuGroup: 20 }),
        pci({ address: '0000:3e:00.0', classCode: '010802', vendorId: '144d', driver: 'nvme', iommuGroup: 21 }),
      ],
      // /sys/block/nvme0n1 -> /sys/devices/virtual/nvme-subsystem/nvme-subsys0/nvme0n1: no PCI address in the path.
      block: [{ name: 'nvme0n1', pci: '0000:3d:00.0', controllers: ['0000:3d:00.0', '0000:3e:00.0'], uses: ['mounted at /'] }],
    });
    const inv = buildInventory({ facts, assignments: none });
    expect(inv.devices).toEqual([]);
    expect(inv.hidden.map((h) => h.category)).toEqual(['host', 'host']);
  });

  it('attaches one of two identical USB devices by its bus and device number', () => {
    const stick = { busnum: 1, vendorId: '1050', productId: '0407', deviceClass: '00', interfaceClasses: ['03'], interfaceDrivers: ['usbhid'], product: 'YubiKey' };
    const facts = host({ usb: [{ ...stick, port: '1-1', devnum: 4 }, { ...stick, port: '1-3', devnum: 5 }] });
    const inv = buildInventory({ facts, assignments: none });
    expect(inv.devices.map((d) => [d.id, d.byAddress])).toEqual([['usb_1-1', true], ['usb_1-3', true]]);
  });

  it('describes a virtual function by its card', () => {
    const facts = host({ pci: [pci({ address: '0000:5e:00.2', classCode: '020000', vendorId: '15b3', physfn: '0000:5e:00.0', iommuGroup: 149 })] });
    expect(buildInventory({ facts, assignments: none }).devices[0]).toMatchObject({ vfOf: '0000:5e:00.0', facts: ['Virtual function of 5e:00.0'] });
  });
});

describe('ids and words', () => {
  it('round-trips device ids', () => {
    expect(pciId('0000:3b:00.0')).toBe('pci_0000_3b_00_0');
    expect(addressFromPciId('pci_0000_3b_00_0')).toBe('0000:3b:00.0');
    expect(addressFromPciId('pci_0000_3b_00_8')).toBeNull();
    expect(portFromUsbId('usb_1-8.2')).toBe('1-8.2');
    expect(portFromUsbId('usb_1-8;rm')).toBeNull();
  });

  it("lists '/' first and leaves the sandbox's /tmp bind mounts out", () => {
    expect(mountSummary(['/boot/efi', '/var/tmp', '/tmp', '/', '/boot'])).toEqual(['/', '/boot', '/boot/efi']);
    expect(mountSummary(['/tmp'])).toEqual(['/tmp']);
  });
});

describe('names', () => {
  it('shortens vendors to the name people use', async () => {
    const { shortVendor, pciName } = await import('./hostDevices.js');
    expect(shortVendor('NVIDIA Corporation')).toBe('NVIDIA');
    expect(shortVendor('ASPEED Technology, Inc.')).toBe('ASPEED');
    expect(shortVendor('Advanced Micro Devices, Inc. [AMD/ATI]')).toBe('AMD');
    expect(shortVendor('Broadcom / LSI')).toBe('Broadcom / LSI');
    const gpu = (deviceName: string, vendorName: string) => pciName({ deviceName, vendorName, vendorId: '10de', deviceId: '2684', classCode: '030000' });
    expect(gpu('AD102 [GeForce RTX 4090]', 'NVIDIA Corporation')).toBe('NVIDIA GeForce RTX 4090');
    expect(gpu('Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M]', 'Advanced Micro Devices, Inc. [AMD/ATI]')).toBe('AMD Radeon RX 7900 XT/7900 XTX/7900M');
    expect(gpu('ASPEED Graphics Family', 'ASPEED Technology, Inc.')).toBe('ASPEED Graphics Family');
    // Outside graphics, brackets hold a mode, not a product.
    expect(pciName({ deviceName: 'C620 Series Chipset Family SATA Controller [AHCI mode]', vendorName: 'Intel Corporation', vendorId: '8086', deviceId: 'a182', classCode: '010601' }))
      .toBe('C620 Series Chipset Family SATA Controller [AHCI mode]');
  });
});
