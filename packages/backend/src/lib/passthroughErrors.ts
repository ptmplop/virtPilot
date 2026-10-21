// libvirt and QEMU explain passthrough failures in their own terms ("group 39
// is not viable", "KVM_SET_USER_MEMORY_REGION failed"). These are the ones
// measured on real hardware, turned into what happened and what to do.
//
// Each returns null when the message isn't one it knows, so callers can fall
// back to the raw error rather than guess.

import type { HostFacts } from './hostFacts.js';
import { cleanName } from './hostDevices.js';

function shortAddress(address: string): string {
  return address.startsWith('0000:') ? address.slice(5) : address;
}

function nameAt(facts: HostFacts | undefined, address: string): string {
  const d = facts?.pci.find((p) => p.address === address);
  return d ? `${cleanName(d.deviceName, 'Device')} (${shortAddress(address)})` : shortAddress(address);
}

export function translatePassthroughError(raw: string, facts?: HostFacts): string | null {
  const msg = raw.replace(/\s+/g, ' ');

  // vfio 0000:00:14.0: group 39 is not viable
  const group = msg.match(/vfio (\S+): group (\d+) is not viable/);
  if (group) {
    const [, address, groupNo] = group;
    const holders = (facts?.pci ?? []).filter((d) => d.iommuGroup === Number(groupNo) && d.address !== address
      && !d.isBridge && d.driver && d.driver !== 'vfio-pci' && d.driver !== 'pci-stub');
    const who = holders.length
      ? holders.map((d) => `${nameAt(facts, d.address)}, driver ${d.driver}`).join('; ')
      : 'another device in the same group';
    return `${nameAt(facts, address)} shares an isolation group with ${who}, which the host is still using. ` +
      'Detach the device and attach it again: VirtPilot then brings the whole group.';
  }

  // Device 0000:af:1f.7 not found: could not access /sys/bus/pci/devices/0000:af:1f.7/config
  const gone = msg.match(/Device (\S+) not found: could not access \/sys\/bus\/pci/);
  if (gone) {
    return `PCI device ${shortAddress(gone[1])} isn't on this host any more. Detach it on the VM's Devices tab, then start the VM.`;
  }

  // qemu: kvm_set_user_memory_region: KVM_SET_USER_MEMORY_REGION failed ... Invalid argument
  if (/KVM_SET_USER_MEMORY_REGION failed/.test(msg)) {
    return "The VM's firmware put a passed-through device's memory window outside what this processor can address, " +
      'and the VM stopped. BIOS firmware does this with large cards: use the device with a VM that boots with UEFI firmware.';
  }

  // Requested operation is not valid: PCI device 0000:3b:00.0 is in use by driver QEMU, domain gpu-uefi
  const busy = msg.match(/PCI device (\S+) is in use by driver QEMU, domain (\S+)/);
  if (busy) {
    return `${nameAt(facts, busy[1])} is in use by the running VM ${busy[2]}. Stop that VM first.`;
  }

  // cannot migrate domain: 0000:18:00.1: VFIO migration is not supported in kernel
  if (/VFIO migration is not supported|domain has assigned non-USB host devices/.test(msg)) {
    return "A VM with PCI devices passed through can't have its memory saved, so this needs the VM to be shut down first.";
  }

  if (/Did not find USB device (\S+)/.test(msg)) {
    const id = msg.match(/Did not find USB device (\S+)/)![1];
    return `USB device ${id} isn't plugged in. Plug it in, or detach it on the VM's Devices tab, then start the VM.`;
  }
  if (/Found multiple USB devices/.test(msg)) {
    return 'Two identical USB devices are plugged in, so libvirt can\'t tell which one the VM should have. ' +
      'Detach the device and attach it again: VirtPilot then picks it by its port.';
  }

  if (/No more available PCI slots/.test(msg)) {
    return 'The running VM has no free slot to take it now.';
  }

  if (/VFIO_MAP_DMA|vfio_dma_map|vfio_container_dma_map|Cannot allocate memory/.test(msg) && /vfio/i.test(msg)) {
    return "The host couldn't lock the VM's memory. A VM with PCI devices passed through keeps all of its memory " +
      'locked on the host, so it needs that much free memory. Give it less memory or stop another VM.';
  }

  if (/(?:Unable|Failed) to reset PCI device|failed to reset/i.test(msg)) {
    return "The card couldn't be reset. It may need the host to be restarted before a VM can use it again.";
  }

  if (/iommu_group|IOMMU.*not (?:found|enabled)|vfio.*No such file or directory/i.test(msg)) {
    return "PCI passthrough isn't available on this host: the IOMMU is off. See Devices for how to turn it on.";
  }

  return null;
}

/** The useful part of a `virsh` failure: its last "error:" lines, not the command line. */
export function virshMessage(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => l.startsWith('error:')).map((l) => l.replace(/^error:\s*/, ''));
  const tail = errors.filter((l) => !/^Failed to (?:start|attach|detach) (?:domain|device)/.test(l));
  return (tail.length ? tail : errors).join(' ') || lines[lines.length - 1] || raw;
}
