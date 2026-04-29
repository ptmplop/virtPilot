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
