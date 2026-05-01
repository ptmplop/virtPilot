export type VmStatus = 'running' | 'stopped' | 'paused' | 'crashed' | 'unknown';

export interface VmDisk {
  target: string;   // e.g. vda, vdb
  source: string;   // file path
  type: 'disk' | 'cdrom';
  bus: string;
  sizeGb?: number;
  bootOrder?: number;
}

export interface VmNic {
  mac: string;
  source: string;   // bridge name
  model: string;
  target?: string;  // tap device
  inboundKbps?: number;   // average inbound rate limit, KiB/s (from guest perspective)
  outboundKbps?: number;  // average outbound rate limit, KiB/s
}

export interface Vm {
  id: string;       // libvirt UUID
  name: string;
  status: VmStatus;
  cpus: number;
  memoryMb: number;
  disks: VmDisk[];
  nics: VmNic[];
  vncDisplay?: string;
  vncPort?: number;
  guestAgent?: boolean;
  autostart?: boolean;
}

export interface VmSummary {
  id: string;
  name: string;
  status: VmStatus;
  cpus: number;
  memoryMb: number;
  guestAgent?: boolean;
  autostart?: boolean;
}

export interface VmStatsSample {
  timestamp: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
  vcpuCount: number;
}

export interface VmStatsResponse {
  current: VmStatsSample;
  history: VmStatsSample[];
}

export interface Template {
  name: string;
  filename: string;
  path: string;
  sizeGb: number;
  createdAt: string;
}

export interface Iso {
  name: string;
  filename: string;
  path: string;
  sizeGb: number;
}

export interface Settings {
  storageRoot: string;
  templatesDir: string;
  isosDir: string;
  vmsDir: string;
  defaultBridge: string;
  libvirtUri: string;
}

export interface VmSnapshot {
  name: string;
  createdAt: string;
  vmState: string;
}

export interface PciAddress {
  domain: number;
  bus: number;
  slot: number;
  function: number;
}

export interface UsbAddress {
  bus: number;
  device: number;
}

export interface HostDevice {
  id: string;           // nodedev name: 'pci_0000_01_00_0' or 'usb_1_2'
  type: 'pci' | 'usb';
  vendor: string;
  vendorId: string;
  product: string;
  productId: string;
  driver?: string;
  iommuGroup?: number;
  pciClass?: string;    // 6-char hex class code, e.g. '030200'
  pciAddress?: PciAddress;
  usbAddress?: UsbAddress;
  assignedTo?: string;  // VM name if currently passed through to a VM
}

export interface CreateVmRequest {
  name: string;
  cpus: number;
  memoryMb: number;
  diskGb: number;
  templateFilename: string;
  bridge: string;
  cloudInit: {
    hostname: string;
    username: string;
    password: string;
    sshKeys?: string[];
  };
}
