import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  createdAt: string;
}

const keysFile = () => path.join(config.storageRoot, 'ssh-keys.json');

async function readAll(): Promise<SshKey[]> {
  try {
    const raw = await fs.readFile(keysFile(), 'utf8');
    return JSON.parse(raw) as SshKey[];
  } catch {
    return [];
  }
}

async function writeAll(keys: SshKey[]): Promise<void> {
  await fs.writeFile(keysFile(), JSON.stringify(keys, null, 2), 'utf8');
}

export async function listSshKeys(): Promise<SshKey[]> {
  return readAll();
}

export async function addSshKey(name: string, publicKey: string): Promise<SshKey> {
  const keys = await readAll();
  const key: SshKey = {
    id: randomUUID(),
    name,
    publicKey: publicKey.trim(),
    createdAt: new Date().toISOString(),
  };
  keys.push(key);
  await writeAll(keys);
  return key;
}

export async function deleteSshKey(id: string): Promise<boolean> {
  const keys = await readAll();
  const filtered = keys.filter((k) => k.id !== id);
  if (filtered.length === keys.length) return false;
  await writeAll(filtered);
  return true;
}

export async function getSshKeysByIds(ids: string[]): Promise<SshKey[]> {
  const keys = await readAll();
  return keys.filter((k) => ids.includes(k.id));
}
