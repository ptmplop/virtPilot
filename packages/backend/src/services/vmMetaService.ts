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

// Every mutator is a read-modify-write over one file, and several routes can
// be in flight at once, so they queue behind a single promise chain. Rejections
// are swallowed on the chain itself (but still surface to the caller) so one
// failed mutation doesn't poison every later one.
let mutationQueue: Promise<unknown> = Promise.resolve();

function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.catch(() => {});
  return next;
}

// Move an unparsable metadata file aside so the next write can start fresh.
// Throws the original parse error if it can't be moved — pretending the file is
// empty while it is still in place would let the next write destroy data we
// might otherwise have recovered by hand.
async function quarantineCorruptFile(parseErr: unknown): Promise<void> {
  const quarantined = `${metaPath()}.corrupt-${Date.now()}`;
  try {
    await fs.rename(metaPath(), quarantined);
  } catch (renameErr) {
    // Already moved by a concurrent read — the file is healed either way.
    if ((renameErr as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw parseErr;
  }
  console.error(
    `[vm-meta] vm-metadata.json was unreadable (${(parseErr as Error).message}) — moved to ${quarantined}; continuing with an empty list`
  );
}

async function readAllRaw(): Promise<VmMeta[]> {
  let raw: string;
  try {
    raw = await fs.readFile(metaPath(), 'utf8');
  } catch (err) {
    // A missing file legitimately means "no VMs recorded yet". Anything else
    // (EACCES, EIO) must propagate — returning [] here would make the next
    // write replace real metadata with an empty list.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('vm-metadata.json is corrupt (expected an array)');
    return parsed as VmMeta[];
  } catch (err) {
    // Unreadable *content* is the one failure we can safely self-heal. Refusing
    // it outright bricked the whole install — VM detail, firewall, backups, SSH
    // and downloads all 500 — with nothing in the product able to rewrite the
    // file, so repair needed shell access. The bytes are already useless, so
    // set them aside and carry on from []. Read/permission errors above still
    // propagate: those mean the real data is intact and must not be overwritten.
    await quarantineCorruptFile(err);
    return [];
  }
}

async function readAll(): Promise<VmMeta[]> {
  const all = await readAllRaw();
  // Decrypt passwords on read. A rotated ENCRYPTION_KEY must not take down
  // every VM endpoint — the record is still useful without its password.
  return all.map((m) => {
    let password = '';
    try {
      password = decryptSecret(m.password) ?? '';
    } catch (err) {
      console.warn(`[vm-meta] Could not decrypt stored password for ${m.uuid}:`, err);
    }
    return { ...m, password };
  });
}

async function writeAll(entries: VmMeta[]): Promise<void> {
  // Encrypt passwords on write.
  const onDisk = entries.map((m) => ({ ...m, password: encryptSecret(m.password) ?? '' }));
  // Write-then-rename so a crash mid-write leaves the previous file intact
  // rather than a truncated one that readAllRaw would then refuse to parse.
  const tmp = `${metaPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, metaPath());
}

export async function saveVmMeta(meta: VmMeta): Promise<void> {
  return serialised(async () => {
    const all = await readAll();
    await writeAll([...all.filter((m) => m.uuid !== meta.uuid), meta]);
  });
}

export async function getVmMeta(uuid: string): Promise<VmMeta | null> {
  const all = await readAll();
  return all.find((m) => m.uuid === uuid) ?? null;
}

export async function listVmMetas(): Promise<VmMeta[]> {
  return readAll();
}

export async function deleteVmMeta(uuid: string): Promise<void> {
  return serialised(async () => {
    const all = await readAll();
    await writeAll(all.filter((m) => m.uuid !== uuid));
  });
}

/**
 * Updates the friendly name on an existing meta record. Used by the rename
 * flow — UUID is the stable key, only the label changes.
 */
export async function setVmMetaName(uuid: string, newName: string): Promise<void> {
  return serialised(async () => {
    const all = await readAll();
    const idx = all.findIndex((m) => m.uuid === uuid);
    if (idx === -1) return;
    all[idx] = { ...all[idx], name: newName };
    await writeAll(all);
  });
}
