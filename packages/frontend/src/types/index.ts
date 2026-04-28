export type VmStatus = 'running' | 'stopped' | 'paused' | 'crashed' | 'unknown';

export interface VmDisk {
  target: string;
  source: string;
  type: 'disk' | 'cdrom';
  bus: string;
  sizeGb?: number;
  bootOrder?: number;
}

export interface VmNic {
  mac: string;
  source: string;
  model: string;
  target?: string;
}

export interface Vm {
  id: string;
  name: string;
  status: VmStatus;
  cpus: number;
  memoryMb: number;
  disks: VmDisk[];
  nics: VmNic[];
  vncDisplay?: string;
  vncPort?: number;
}

export interface VmSummary {
  id: string;
  name: string;
  status: VmStatus;
  cpus: number;
  memoryMb: number;
  guestAgent?: boolean;
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

export interface VmNetworkAlloc {
  networkId: string;
  mac: string;
  ip?: string;
  isPrimary: boolean;
}

export interface VmMeta {
  vmName: string;
  username: string;
  password: string;
  networks?: VmNetworkAlloc[];
  createdAt: string;
  sourceTemplateFilename?: string;
}

export interface VmSnapshot {
  name: string;
  createdAt: string;
  vmState: string;
}

export type NetworkType = 'nat' | 'bridge' | 'existing-bridge';
export type BridgeIpMode = 'dhcp' | 'static';

export interface Network {
  id: string;
  name: string;
  type: NetworkType;
  /** bridge / existing-bridge only */
  ipMode?: BridgeIpMode;
  cidr: string;
  gateway: string;
  dns: string[];
  bridge: string;
  /** bridge only — physical NIC enslaved to bridge */
  physicalNic?: string;
  /** nat only */
  libvirtName?: string;
  createdAt: string;
}

export interface NetworkIpStatus {
  ip: string;
  allocated: boolean;
  vmName?: string;
}

export interface HostNic {
  name: string;
  mac: string;
  speed?: string;
  inUse: boolean;
  /** True if the NIC has active IPv4 addresses — unsafe to enslave directly */
  hasIps: boolean;
}

export interface DhcpReservation {
  networkId: string;
  libvirtName: string;
  mac: string;
  ip: string;
  vmName: string;
  createdAt: string;
}

export interface PortForward {
  id: string;
  networkId: string;
  vmName: string;
  mac: string;
  /** Reserved DHCP IP assigned to this VM NIC */
  vmIp: string;
  protocol: 'tcp' | 'udp';
  hostPort: number;
  vmPort: number;
  description?: string;
  createdAt: string;
}

export interface FirewallRule {
  id: string;
  direction: 'inbound' | 'outbound';
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  portRange?: string;
  action: 'allow' | 'drop';
  description?: string;
}

export interface Settings {
  storageRoot: string;
  templatesDir: string;
  isosDir: string;
  vmsDir: string;
  defaultBridge: string;
  libvirtUri: string;
  kvmAvailable: boolean;
  maxLogs: number;
}

export interface VmDiskFile {
  vmName: string;
  filename: string;
  sizeGb: number;
  vmExists: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  type: string;
  subject: string;
  status: 'success' | 'error';
  output?: string;
  durationMs?: number;
}
