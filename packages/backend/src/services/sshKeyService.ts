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

// Two lines are the same key when their type and base64 body match; the trailing
// comment is free text and does not make a different key.
export function sameSshKey(a: string, b: string): boolean {
  const [ta, ba] = a.trim().split(/\s+/);
  const [tb, bb] = b.trim().split(/\s+/);
  return !!ta && !!ba && ta === tb && ba === bb;
}

export class DuplicateSshKeyError extends Error {
  constructor(public readonly existing: SshKey) {
    super(`This key is already saved as "${existing.name}"`);
  }
}

export async function addSshKey(name: string, publicKey: string): Promise<SshKey> {
  const keys = await readAll();
  // Saving the same key twice only produced a second, indistinguishable entry —
  // and a VM provisioned with both would carry the key twice in authorized_keys.
  const existing = keys.find((k) => sameSshKey(k.publicKey, publicKey));
  if (existing) throw new DuplicateSshKeyError(existing);
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
