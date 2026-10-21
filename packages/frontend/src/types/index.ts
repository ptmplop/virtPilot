export type VmStatus = 'running' | 'stopped' | 'paused' | 'crashed' | 'unknown';

export interface VmDisk {
  target: string;
  source: string;
  type: 'disk' | 'cdrom';
  bus: string;
  sizeGb?: number;
  bootOrder?: number;
  fileMissing?: boolean;
  storageDirId?: string;
  storageDirName?: string;
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
  /** Image the VM was created from — used to derive an OS logo. */
  sourceTemplateFilename?: string;
  /** Recent CPU% samples (oldest→newest) for the roster sparkline. */
  cpuSpark?: number[];
}

export interface VmStatsSample {
  timestamp: number;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  /** 'host' when the guest reports no memory stats and the figure is QEMU's resident size. */
  memSource?: 'guest' | 'host';
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

export type VmMetricsRange = '1h' | '24h' | '7d' | '30d';

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
  storageDirId: string;
  storageDirName: string;
}

export interface Iso {
  name: string;
  filename: string;
  path: string;
  sizeGb: number;
  storageDirId: string;
  storageDirName: string;
}

export type StorageDirPurpose = 'templates' | 'isos' | 'vmDisks';

export interface StorageDirUsage {
  totalBytes: number;
  freeBytes: number;
  usedByVirtpilotBytes: number;
  healthy: boolean;
  error?: string;
  warnings: string[];
}

export interface StorageDir {
  id: string;
  name: string;
  path: string;
  purposes: StorageDirPurpose[];
  isDefaultTemplates: boolean;
  isDefaultIsos: boolean;
  isDefaultVmDisks: boolean;
  createdAt: string;
}

export interface StorageDirWithUsage extends StorageDir {
  usage: StorageDirUsage;
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
  /** The address this browser reaches the backend from, as the allowlist sees it. */
  clientIp?: string;
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
  backingFilename?: string;
}

export type BackupConsistency = 'app-consistent' | 'offline' | 'crash-consistent';
export type BackupKind = 'full' | 'incremental';
export type BackupKindRequest = BackupKind | 'auto';
export type BackupCopyMethod = 'libvirt-backup' | 'snapshot-convert' | 'direct-convert' | 'offline-convert';

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
  kind: BackupKind;
  parentBackupId?: string;
  method?: BackupCopyMethod;
  compressed?: boolean;
  notes?: string[];
  /** Left a libvirt checkpoint behind, so the next run can chain onto this one. */
  hasCheckpoint: boolean;
  /** This run tried to extend an incremental chain, whether or not it managed to. */
  chainRequested: boolean;
  /** An ancestor this backup needs is missing — not restorable. */
  chainBroken: boolean;
  /** Another backup builds on this one, so deleting it alone is refused. */
  hasDependents: boolean;
  /** On-disk size of this backup plus every ancestor it needs. */
  chainSizeBytes: number;
  /** Result of the last explicit verification, if it has ever been run. */
  lastVerify?: BackupVerifyRecord;
}

export interface BackupVerifyRecord {
  checkedAt: string;
  ok: boolean;
  summary: string;
}

export interface BackupVerifyLink {
  backupId: string;
  kind: BackupKind;
  target: string;
  filename: string;
  present: boolean;
  ok: boolean;
  detail?: string;
}

export interface BackupVerifyResult {
  backupId: string;
  ok: boolean;
  checkedAt: string;
  links: BackupVerifyLink[];
  summary: string;
}

export interface BackupAlert {
  vmUuid: string;
  vmName: string;
  severity: 'error' | 'warning';
  kind:
    | 'schedule-failed'
    | 'chain-broken'
    | 'schedule-overdue'
    | 'verify-failed'
    /** Scheduled for incrementals, but every recent run degraded to a full. */
    | 'incremental-degraded'
    /** Disk held by backup directories nothing can restore from. */
    | 'orphaned-data';
  message: string;
}

export interface IncrementalStatus {
  supported: boolean;
  chainLength: number;
  canChain: boolean;
}

export interface BackupVmSummary {
  vmUuid: string;
  vmName: string;
  backupCount: number;
  totalSizeBytes: number;
  /** Bytes held by backup directories nothing can restore from. */
  unusableSizeBytes: number;
  unusableCount: number;
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
  mode?: BackupScheduleMode;
  /** Incremental mode: take a fresh full backup once the chain reaches this length. */
  fullEvery?: number;
  /** How the last scheduled run ended — surfaced so a silent failure isn't. */
  lastRunStatus?: 'success' | 'error';
  lastError?: string;
}

export type BackupScheduleMode = 'full' | 'incremental';

export interface VmDiskFile {
  vmUuid: string;
  vmName: string;
  filename: string;
  sizeGb: number;
  vmExists: boolean;
  vmStatus: VmStatus | null;
  storageDirId: string;
  storageDirName: string;
}

// ─── Passthrough (GET /api/devices, /api/vms/:uuid/devices) ──────────────────

export type DeviceKind = 'gpu' | 'network' | 'storage' | 'usb-controller' | 'audio' | 'accelerator' | 'other' | 'usb';

export interface DeviceNote {
  tone: 'info' | 'warn';
  text: string;
}

export interface GroupMember {
  address: string;
  name: string;
  kindLabel: string;
  driver?: string;
}

export interface VmRef {
  uuid: string;
  name: string;
  running: boolean;
}

/** A device (or IOMMU group, led by its main device) the host can give to a VM. */
export interface PassthroughDevice {
  id: string;
  type: 'pci' | 'usb';
  kind: DeviceKind;
  kindLabel: string;
  name: string;
  vendor: string;
  address: string;
  vendorId: string;
  productId: string;
  driver?: string;
  iommuGroup?: number;
  numaNode?: number;
  members: GroupMember[];
  facts: string[];
  notes: DeviceNote[];
  usedBy: VmRef[];
  kept: boolean;
  sriov?: { total: number; current: number };
  vfOf?: string;
  largestBar?: number;
  byAddress?: boolean;
}

export interface HiddenDevice {
  id: string;
  type: 'pci' | 'usb';
  name: string;
  vendor: string;
  address: string;
  category: 'host' | 'chipset' | 'bridge' | 'hub';
  reason: string;
}

export interface HostCheck {
  key: 'cpu' | 'iommu' | 'irq' | 'vfio';
  label: string;
  state: 'ok' | 'off' | 'warn' | 'na';
  value: string;
  fix?: string;
}

export interface PassthroughHost {
  pciReady: boolean;
  usbReady: boolean;
  checks: HostCheck[];
  blocker?: string;
}

export interface DeviceInventory {
  host: PassthroughHost;
  devices: PassthroughDevice[];
  hidden: HiddenDevice[];
  /** Keep for VMs and virtual functions need the installer's root helper. */
  hostTools: boolean;
}

export type VmDeviceState = 'attached' | 'pending-attach' | 'pending-detach' | 'missing';

export interface VmDevice {
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
  /** Detaching takes it out of the running guest now, rather than at the next stop. */
  liveDetach: boolean;
}

export interface VmDevicesView {
  running: boolean;
  firmware: 'uefi' | 'bios';
  devices: VmDevice[];
}

export interface DeviceChangeResult {
  ok: boolean;
  applied: 'now' | 'next-start' | 'next-stop';
  reason?: string;
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
