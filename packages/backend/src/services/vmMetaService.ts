import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { encryptSecret, decryptSecret } from '../lib/secretsCrypto.js';

export interface VmNetworkAlloc {
  networkId: string;
  mac: string;
  /** Assigned IP — only present for bridge/static networks */
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

const metaPath = () => path.join(config.storageRoot, 'vm-metadata.json');

async function readAllRaw(): Promise<VmMeta[]> {
  try {
    return JSON.parse(await fs.readFile(metaPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function readAll(): Promise<VmMeta[]> {
  const all = await readAllRaw();
  // Decrypt passwords on read. Legacy plaintext values pass through.
  return all.map((m) => ({ ...m, password: decryptSecret(m.password) ?? '' }));
}

async function writeAll(entries: VmMeta[]): Promise<void> {
  // Encrypt passwords on write.
  const onDisk = entries.map((m) => ({ ...m, password: encryptSecret(m.password) ?? '' }));
  await fs.writeFile(metaPath(), JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export async function saveVmMeta(meta: VmMeta): Promise<void> {
  const all = await readAll();
  await writeAll([...all.filter((m) => m.vmName !== meta.vmName), meta]);
}

export async function getVmMeta(vmName: string): Promise<VmMeta | null> {
  const all = await readAll();
  return all.find((m) => m.vmName === vmName) ?? null;
}

export async function deleteVmMeta(vmName: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter((m) => m.vmName !== vmName));
}
