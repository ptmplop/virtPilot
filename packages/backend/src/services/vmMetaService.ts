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
  /** Storage identity — never changes */
  uuid: string;
  /** User-typed display label — mutable via rename */
  name: string;
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
  // Decrypt passwords on read.
  return all.map((m) => ({ ...m, password: decryptSecret(m.password) ?? '' }));
}

async function writeAll(entries: VmMeta[]): Promise<void> {
  // Encrypt passwords on write.
  const onDisk = entries.map((m) => ({ ...m, password: encryptSecret(m.password) ?? '' }));
  await fs.writeFile(metaPath(), JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export async function saveVmMeta(meta: VmMeta): Promise<void> {
  const all = await readAll();
  await writeAll([...all.filter((m) => m.uuid !== meta.uuid), meta]);
}

export async function getVmMeta(uuid: string): Promise<VmMeta | null> {
  const all = await readAll();
  return all.find((m) => m.uuid === uuid) ?? null;
}

export async function listVmMetas(): Promise<VmMeta[]> {
  return readAll();
}

export async function deleteVmMeta(uuid: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter((m) => m.uuid !== uuid));
}

/**
 * Updates the friendly name on an existing meta record. Used by the rename
 * flow — UUID is the stable key, only the label changes.
 */
export async function setVmMetaName(uuid: string, newName: string): Promise<void> {
  const all = await readAll();
  const idx = all.findIndex((m) => m.uuid === uuid);
  if (idx === -1) return;
  all[idx] = { ...all[idx], name: newName };
  await writeAll(all);
}
