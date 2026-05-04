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
  inboundKbps?: number;
  outboundKbps?: number;
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

export type VmMetricsRange = '1h' | '24h';

export interface VmMetricsPoint {
  ts: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
}

export interface VmMetricsResponse {
  range: VmMetricsRange;
  history: VmMetricsPoint[];
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
  uuid: string;
  name: string;
  username: string;
  // Password is fetched separately via /credentials so it doesn't ride along
  // in the routine /meta poll, the React Query cache, or any incidental log.
  networks?: VmNetworkAlloc[];
  createdAt: string;
  sourceTemplateFilename?: string;
}

export interface VmCredentials {
  username: string;
  password: string;
}

export interface VmSnapshot {
  name: string;
  createdAt: string;
  vmState: string;
  sizeBytes?: number;
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
  vmUuid?: string;
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
  vmUuid: string;
  createdAt: string;
}

export interface PortForward {
  id: string;
  networkId: string;
  vmUuid: string;
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
  source?: string;
  destination?: string;
  icmpType?: string;
  action: 'allow' | 'drop';
  description?: string;
}

export interface FirewallConfig {
  rules: FirewallRule[];
  defaultInbound: 'allow' | 'drop';
  defaultOutbound: 'allow' | 'drop';
  allowEstablishedInbound?: boolean;
  allowEstablishedOutbound?: boolean;
}

export interface BackupSettings {
  retentionDays: number;
  compression: boolean;
}

export interface Settings {
  storageRoot: string;
  templatesDir: string;
  isosDir: string;
  vmsDir: string;
  defaultBridge: string;
  libvirtUri: string;
  kvmAvailable: boolean;
  backupRoot: string;
  maxLogs: number;
  ipWhitelist: string[];
  totpEnabled: boolean;
  backup: BackupSettings;
  templateSetDismissed: boolean;
}

export type BackupTrigger = 'manual' | 'scheduled';

export interface BackupInProgress {
  vmUuid: string;
  vmName: string;
  startedAt: string;
  triggerType: BackupTrigger;
}
export type BackupFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface BackupDiskEntry {
  target: string;
  filename: string;
  format: 'qcow2';
  sizeBytes: number;
  originalPath: string;
}

export type BackupConsistency = 'app-consistent' | 'offline' | 'crash-consistent';

export interface BackupEntry {
  id: string;
  vmUuid: string;
  vmName: string;
  createdAt: string;
  sizeBytes: number;
  consistency: BackupConsistency;
  triggerType: BackupTrigger;
  scheduleFrequency?: BackupFrequency;
  vmStateAtBackup: string;
  retentionDays: number;
  disks: BackupDiskEntry[];
}

export interface BackupVmSummary {
  vmUuid: string;
  vmName: string;
  backupCount: number;
  totalSizeBytes: number;
  lastBackupAt: string | null;
  schedule: BackupSchedule | null;
  vmExists: boolean;
}

export interface BackupSchedule {
  vmUuid: string;
  vmName: string;
  frequency: BackupFrequency;
  hour: number;
  minute: number;
  dayOfWeek: number;
  dayOfMonth: number;
  retentionDays: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

export interface VmDiskFile {
  vmUuid: string;
  vmName: string;
  filename: string;
  sizeGb: number;
  vmExists: boolean;
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
  id: string;
  type: 'pci' | 'usb';
  vendor: string;
  vendorId: string;
  product: string;
  productId: string;
  driver?: string;
  iommuGroup?: number;
  pciClass?: string;
  pciAddress?: PciAddress;
  usbAddress?: UsbAddress;
  assignedTo?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  type: string;
  subject: string;
  subjectUuid?: string;
  status: 'success' | 'error';
  output?: string;
  durationMs?: number;
}
