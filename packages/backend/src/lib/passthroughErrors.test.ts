import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { translatePassthroughError, virshMessage } from './passthroughErrors.js';
import type { HostFacts } from './hostFacts.js';

const facts: HostFacts = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'bp8-vt-on.json'), 'utf8'));

// Every message here was produced on bp8 (libvirt 10.0, QEMU 8.2, kernel 6.8).
describe('translatePassthroughError', () => {
  it('names the device still holding an isolation group', () => {
    const raw = `error: internal error: QEMU unexpectedly closed the monitor (vm='nic-bios'): 2026-10-21T17:42:48.863175Z qemu-system-x86_64: -device {"driver":"vfio-pci","host":"0000:00:14.0","id":"hostdev1","bus":"pci.16","addr":"0x1"}: vfio 0000:00:14.0: group 39 is not viable
Please ensure all devices within the iommu_group are bound to their vfio bus driver.`;
    expect(translatePassthroughError(raw, facts)).toBe(
      'C620 Series Chipset Family USB 3.0 xHCI Controller (00:14.0) shares an isolation group with ' +
      'C620 Series Chipset Family Thermal Subsystem (00:14.2), driver intel_pch_thermal, which the host is still using. ' +
      'Detach the device and attach it again: VirtPilot then brings the whole group.');
  });

  it('says a device has left the host', () => {
    expect(translatePassthroughError('error: Device 0000:af:1f.7 not found: could not access /sys/bus/pci/devices/0000:af:1f.7/config: No such file or directory'))
      .toBe("PCI device af:1f.7 isn't on this host any more. Detach it on the VM's Devices tab, then start the VM.");
  });

  it('explains the BIOS firmware crash with a large card', () => {
    const raw = '2026-10-21T17:43:02.904737Z qemu-system-x86_64: kvm_set_user_memory_region: KVM_SET_USER_MEMORY_REGION failed, slot=4, start=0x400000000000, size=0x200000: Invalid argument';
    expect(translatePassthroughError(raw)).toContain('use the device with a VM that boots with UEFI firmware');
  });

  it('explains why a running VM with a PCI device cannot save its memory', () => {
    expect(translatePassthroughError('error: Requested operation is not valid: cannot migrate domain: 0000:18:00.1: VFIO migration is not supported in kernel'))
      .toContain('needs the VM to be shut down first');
  });

  it('turns a full hotplug bus into a reason', () => {
    expect(translatePassthroughError('error: internal error: No more available PCI slots')).toBe('The running VM has no free slot to take it now.');
  });

  it('leaves unknown errors alone', () => {
    expect(translatePassthroughError('error: something else entirely')).toBeNull();
  });
});

describe('virshMessage', () => {
  it('keeps the cause and drops the command line', () => {
    const raw = `Command failed: virsh -c qemu:///system attach-device f5534e30 /tmp/vp-device.xml --live
error: Failed to attach device from /tmp/vp-device.xml
error: internal error: No more available PCI slots`;
    expect(virshMessage(raw)).toBe('internal error: No more available PCI slots');
  });
});
