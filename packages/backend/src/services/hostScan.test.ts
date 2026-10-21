import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { describeBlockUses, parseBarSizes, parseLspciNames, pciFromSysPath, usbPortFromSysPath } from './hostScan.js';

describe('sysfs parsing', () => {
  it("sizes an L4's memory BARs from its resource file", () => {
    const resource = [
      '0x00000000ab000000 0x00000000abffffff 0x0000000000040200',
      '0x000038a000000000 0x000038a7ffffffff 0x000000000014220c',
      '0x0000000000000000 0x0000000000000000 0x0000000000000000',
      '0x000038b840000000 0x000038b841ffffff 0x000000000014220c',
      '0x0000000000000000 0x0000000000000000 0x0000000000000000',
      '0x0000000000003000 0x000000000000307f 0x0000000000040101',
      '0x00000000ac000000 0x00000000ac07ffff 0x0000000000046200',
    ].join('\n');
    // BAR 5 is I/O ports; the last line is the expansion ROM. Neither counts.
    expect(parseBarSizes(resource)).toEqual([16 * 1024 ** 2, 32 * 1024 ** 3, 32 * 1024 ** 2]);
  });

  it('finds the device nearest the leaf of a sysfs path', () => {
    expect(pciFromSysPath('/sys/devices/pci0000:85/0000:85:00.0/0000:89:00.0/nvme/nvme0/nvme0n1')).toBe('0000:89:00.0');
    expect(usbPortFromSysPath('/sys/devices/pci0000:00/0000:00:14.0/usb1/1-8/1-8.2/1-8.2:1.0/host6/target6:0:0/6:0:0:0/block/sdb')).toBe('1-8.2');
    expect(pciFromSysPath(undefined)).toBeUndefined();
  });

  it('reads names from lspci -vmm', () => {
    const out = `Slot:\t0000:3b:00.0\nClass:\t3D controller [0302]\nVendor:\tNVIDIA Corporation [10de]\nDevice:\tAD104GL [L4] [27b8]\nSVendor:\tNVIDIA Corporation [10de]\nSDevice:\tAD104GL [L4] [16ca]\n\nSlot:\t0000:00:00.0\nVendor:\tIntel Corporation [8086]\nDevice:\tSky Lake-E DMI3 Registers [2020]\n`;
    const names = parseLspciNames(out);
    expect(names.get('0000:3b:00.0')).toEqual({ vendorName: 'NVIDIA Corporation', deviceName: 'AD104GL [L4]' });
    expect(names.get('0000:00:00.0')?.deviceName).toBe('Sky Lake-E DMI3 Registers');
  });

  it("describes what the host does with its disks (bp8's lsblk)", () => {
    const { blockdevices } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', '__fixtures__', 'bp8-lsblk.json'), 'utf8'));
    const [sda, nvme] = blockdevices;
    expect(describeBlockUses(sda)).toEqual([]);
    expect(describeBlockUses(nvme)).toEqual([
      'mounted at /boot/efi',
      'mounted at /boot',
      'mounted at / (through LVM ubuntu--vg-ubuntu--lv)',
    ]);
  });

  it('counts an unmounted LVM or RAID layer as use', () => {
    expect(describeBlockUses({ kname: 'sdb', children: [{ name: 'vg-data', type: 'lvm', mountpoints: [null] }] })).toEqual(['holds LVM vg-data']);
    expect(describeBlockUses({ kname: 'sdc', fstype: 'zfs_member' })).toEqual(['part of a ZFS pool']);
  });
});
