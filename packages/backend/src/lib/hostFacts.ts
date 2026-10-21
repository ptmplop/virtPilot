// The raw facts passthrough decisions are made from, as read off one host.
//
// Everything here is plain data so the decisions themselves (lib/hostDevices.ts)
// are pure functions over a snapshot: tests replay snapshots captured on real
// machines (lib/__fixtures__) instead of mocking sysfs.

export interface PciFacts {
  /** Full address, e.g. '0000:3b:00.0'. */
  address: string;
  /** Six hex digits, lowercase, no 0x: class, subclass, programming interface ('030200'). */
  classCode: string;
  vendorId: string;
  deviceId: string;
  subsystemVendorId?: string;
  subsystemDeviceId?: string;
  /** Names from the PCI ID database via lspci, when it knows them. */
  vendorName?: string;
  deviceName?: string;
  /** The host driver bound right now. */
  driver?: string;
  iommuGroup?: number;
  /** Only VGA-class devices carry boot_vga; true for the one firmware drew its screen on. */
  bootVga?: boolean;
  /** Reset methods the kernel can use ('flr', 'bus', 'pm'...). Empty: none. Absent: kernel too old to say. */
  resetMethods?: string[];
  sriovTotalVfs?: number;
  sriovNumVfs?: number;
  /** For a virtual function, the address of its physical function. */
  physfn?: string;
  numaNode?: number;
  /** Sizes in bytes of the memory BARs (0-5) that are present. */
  memoryBars: number[];
  driverOverride?: string;
  /** Config-space header type: 0 endpoint, 1 PCI-to-PCI bridge, 2 CardBus bridge. */
  headerType?: number;
  /** Header type 1 or 2. VFIO lets these share a group with a passed-through device whatever their driver. */
  isBridge: boolean;
  /** The upstream PCI device this one sits behind, if any. */
  parent?: string;
}

export interface UsbFacts {
  /** sysfs name: '1-8.2'. Root hubs are 'usb1'. */
  port: string;
  busnum: number;
  devnum: number;
  vendorId: string;
  productId: string;
  /** bDeviceClass as two hex digits; '09' is a hub, '00' means "see the interfaces". */
  deviceClass: string;
  /** bInterfaceClass of each interface, two hex digits ('08' mass storage, '03' HID, '09' hub). */
  interfaceClasses: string[];
  /** Drivers bound to the interfaces (usb-storage, usbhid, hub...). */
  interfaceDrivers: string[];
  manufacturer?: string;
  product?: string;
  /** The PCI USB controller the device hangs off. */
  controller?: string;
}

export interface BlockFacts {
  /** Kernel name: 'nvme0n1', 'sda'. */
  name: string;
  /** PCI device that owns the disk (the controller), if it sits on PCI. */
  pci?: string;
  /** USB port the disk hangs off, for USB drives. */
  usbPort?: string;
  /**
   * Every PCI controller that reaches the disk. One for most disks; several for a
   * multipath NVMe namespace, whose own sysfs path is virtual and names none.
   */
  controllers?: string[];
  /** What the host uses it for, in words: 'mounted at /boot', 'holds dm-0', 'swap'. Empty when unused. */
  uses: string[];
}

export interface NetFacts {
  name: string;
  pci?: string;
  usbPort?: string;
  /** Global and site addresses on the interface itself. */
  addresses: string[];
  /** Interfaces stacked on this one (its bridge or bond master, VLANs), followed upwards. */
  uppers: string[];
  /** Addresses found anywhere in `uppers`. */
  upperAddresses: string[];
  /** True when the interface, or something stacked on it, is a bridge (VMs plug into bridges). */
  feedsBridge?: string;
}

export interface DrmFacts {
  card: string;
  pci?: string;
  connectors: { name: string; connected: boolean; enabled: boolean }[];
}

export interface HostFacts {
  kernel: string;
  cpu: { vendor: 'intel' | 'amd' | 'other'; model: string; vmx: boolean; svm: boolean };
  /** /dev/kvm exists. */
  kvm: boolean;
  /** ACPI tables that describe an IOMMU: DMAR (Intel VT-d) and IVRS (AMD-Vi). */
  acpi: { dmar: boolean; ivrs: boolean };
  iommuGroups: number;
  cmdline: string;
  /** Kernel log lines about virtualisation and the IOMMU, when the journal could be read. */
  journal: string[];
  /** /proc/interrupts shows remapped interrupts (IR-PCI-MSI, IR-IO-APIC). */
  irqRemapping: boolean;
  allowUnsafeInterrupts: boolean;
  /** 'unknown' when the modules tree can't be read (the service's ProtectKernelModules hides it). */
  vfioPci: 'loaded' | 'available' | 'missing' | 'unknown';
  pci: PciFacts[];
  usb: UsbFacts[];
  block: BlockFacts[];
  net: NetFacts[];
  drm: DrmFacts[];
  memAvailableKb: number;
  /** Free memory in the hugepage pool, which MemAvailable leaves out. */
  hugepagesFreeKb: number;
  /** ZFS ARC the kernel can give back under pressure (size - c_min). */
  zfsArcReclaimableKb: number;
}
