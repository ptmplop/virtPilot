import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getDb } from './db.js';
import { ValidationError, validateVmUuid, validateFilename } from '../lib/validate.js';

// Per-storage-dir subfolder names. Same names regardless of which storage dir
// the operator picks — keeps the layout predictable when sshing onto the host.
// `vms/` is shared with the system-root vmsDir for the default storage dir
// (they're literally the same folder); for non-default dirs only the disk
// files live there, NVRAM and name.txt stay at config.vmsDir.
const TEMPLATES_SUBDIR = 'templates';
const ISOS_SUBDIR = 'isos';
const VM_DISKS_SUBDIR = 'vms';

export type StorageDirPurpose = 'templates' | 'isos' | 'vmDisks';

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

export interface StorageDirUsage {
  totalBytes: number;
  freeBytes: number;
  usedByVirtpilotBytes: number;
  healthy: boolean;
  error?: string;
}

interface StorageDirRow {
  id: string;
  name: string;
  path: string;
  purposes: string;
  is_default_templates: number;
  is_default_isos: number;
  is_default_vm_disks: number;
  created_at: number;
}

function rowToDir(row: StorageDirRow): StorageDir {
  let purposes: StorageDirPurpose[] = [];
  try {
    const parsed = JSON.parse(row.purposes) as unknown;
    if (Array.isArray(parsed)) {
      purposes = parsed.filter((p): p is StorageDirPurpose =>
        p === 'templates' || p === 'isos' || p === 'vmDisks',
      );
    }
  } catch {
    // ignore — fall through to empty list
  }
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    purposes,
    isDefaultTemplates: row.is_default_templates === 1,
    isDefaultIsos: row.is_default_isos === 1,
    isDefaultVmDisks: row.is_default_vm_disks === 1,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// Refuse paths that point at host-system roots — chowning/chmoding these is
// either dangerous or pointless, and a typo here lights up the host.
const FORBIDDEN_PARENTS = [
  '/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot',
  '/dev', '/proc', '/sys', '/run', '/root', '/home',
];

function assertPathSafe(absPath: string): void {
  if (!path.isAbsolute(absPath)) {
    throw new ValidationError('path', absPath, 'must be absolute');
  }
  const norm = path.normalize(absPath);
  if (norm.includes('..')) {
    throw new ValidationError('path', absPath, 'must not contain ..');
  }
  if (FORBIDDEN_PARENTS.includes(norm)) {
    throw new ValidationError('path', absPath, 'system path not allowed');
  }
  // Don't let the operator point a storage dir at the install dir — `update.sh`
  // runs `npm ci` and `npm run build` there, which mutates files unrelated to
  // their VM disks.
  if (norm === config.repoDir || norm.startsWith(config.repoDir + path.sep)) {
    throw new ValidationError('path', absPath, 'cannot be inside the VirtPilot install directory');
  }
  // Reject paths inside config.storageRoot's reserved system subdirs. The
  // storageRoot itself is fine — that's the seeded default — but nesting a
  // registered dir inside cloud-init/, backups/, .uploads/, or an existing
  // dir would let listings recurse into VirtPilot-internal scaffolding and
  // produce confusing usage numbers (or break /var/lib/virtpilot.db locks).
  const reservedRoots = [
    path.join(config.storageRoot, 'cloud-init'),
    path.join(config.storageRoot, 'backups'),
    path.join(config.storageRoot, '.uploads'),
    path.join(config.storageRoot, 'tls'),
  ];
  for (const reserved of reservedRoots) {
    if (norm === reserved || norm.startsWith(reserved + path.sep)) {
      throw new ValidationError('path', absPath, `cannot be inside ${reserved} (reserved for VirtPilot internals)`);
    }
  }
}

function purposesToJson(purposes: StorageDirPurpose[]): string {
  // Dedupe + sort for stable comparison and clean storage.
  const set = new Set(purposes);
  return JSON.stringify([...set].sort());
}

export function getTemplatesSubdir(dir: StorageDir): string {
  return path.join(dir.path, TEMPLATES_SUBDIR);
}

export function getIsosSubdir(dir: StorageDir): string {
  return path.join(dir.path, ISOS_SUBDIR);
}

export function getVmDisksSubdir(dir: StorageDir): string {
  return path.join(dir.path, VM_DISKS_SUBDIR);
}

// 0770 + group ownership so libvirt-qemu (a member of the virtpilot group)
// can traverse and write — same trick install.sh applies to /var/lib/virtpilot.
async function ensurePurposeSubdirs(dir: StorageDir): Promise<void> {
  const subs: string[] = [];
  if (dir.purposes.includes('templates')) subs.push(getTemplatesSubdir(dir));
  if (dir.purposes.includes('isos')) subs.push(getIsosSubdir(dir));
  if (dir.purposes.includes('vmDisks')) subs.push(getVmDisksSubdir(dir));
  for (const sub of subs) {
    await fs.mkdir(sub, { recursive: true });
    await fs.chmod(sub, 0o770).catch(() => { /* permissions issue — surfaces on first write */ });
  }
}

export async function listDirs(): Promise<StorageDir[]> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM storage_dirs ORDER BY created_at ASC').all() as StorageDirRow[];
  return rows.map(rowToDir);
}

export async function getDir(id: string): Promise<StorageDir | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM storage_dirs WHERE id = ?').get(id) as StorageDirRow | undefined;
  return row ? rowToDir(row) : null;
}

export async function getDirsForPurpose(purpose: StorageDirPurpose): Promise<StorageDir[]> {
  const dirs = await listDirs();
  return dirs.filter((d) => d.purposes.includes(purpose));
}

export async function getDefaultDirFor(purpose: StorageDirPurpose): Promise<StorageDir | null> {
  const dirs = await getDirsForPurpose(purpose);
  if (dirs.length === 0) return null;
  const defaultFlag =
    purpose === 'templates' ? 'isDefaultTemplates' :
    purpose === 'isos' ? 'isDefaultIsos' : 'isDefaultVmDisks';
  return dirs.find((d) => d[defaultFlag]) ?? dirs[0];
}

// First-boot seed: create a row pointing at config.storageRoot so existing
// installs (and fresh installs) keep working without the operator touching
// the new Storage page. Idempotent — does nothing once any rows exist.
export async function seedDefault(): Promise<void> {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM storage_dirs').get() as { c: number }).c;
  if (count > 0) return;
  const id = randomUUID();
  const now = Date.now();
  const purposes = JSON.stringify(['isos', 'templates', 'vmDisks']);
  db.prepare(`
    INSERT INTO storage_dirs (id, name, path, purposes, is_default_templates, is_default_isos, is_default_vm_disks, created_at)
    VALUES (?, ?, ?, ?, 1, 1, 1, ?)
  `).run(id, 'Local', config.storageRoot, purposes, now);
}

interface CreateDirInput {
  name: string;
  path: string;
  purposes: StorageDirPurpose[];
  setDefault?: { templates?: boolean; isos?: boolean; vmDisks?: boolean };
}

export async function createDir(input: CreateDirInput): Promise<StorageDir> {
  const trimmedName = input.name.trim();
  if (!trimmedName) throw new ValidationError('name', input.name, 'required');
  if (trimmedName.length > 64) throw new ValidationError('name', input.name, 'max 64 chars');
  if (input.purposes.length === 0) {
    throw new ValidationError('purposes', input.purposes, 'at least one purpose required');
  }
  for (const p of input.purposes) {
    if (p !== 'templates' && p !== 'isos' && p !== 'vmDisks') {
      throw new ValidationError('purposes', p, 'unknown purpose');
    }
  }

  const absPath = path.resolve(input.path.trim());
  assertPathSafe(absPath);

  // Path must already exist as a directory and be writable. Mounting iSCSI
  // or NFS is the operator's job — we don't try to mount anything ourselves.
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    throw new ValidationError('path', absPath, 'does not exist (mount it first)');
  }
  if (!stat.isDirectory()) {
    throw new ValidationError('path', absPath, 'is not a directory');
  }
  try {
    await fs.access(absPath, fssync.constants.W_OK);
  } catch {
    throw new ValidationError('path', absPath, 'not writable by VirtPilot service user');
  }

  const db = getDb();
  const dupeName = db.prepare('SELECT id FROM storage_dirs WHERE name = ?').get(trimmedName);
  if (dupeName) throw new ValidationError('name', trimmedName, 'already in use');
  const dupePath = db.prepare('SELECT id FROM storage_dirs WHERE path = ?').get(absPath);
  if (dupePath) throw new ValidationError('path', absPath, 'already registered');

  const id = randomUUID();
  const now = Date.now();
  const purposesJson = purposesToJson(input.purposes);
  const wantDefaults = input.setDefault ?? {};

  // If the caller asks to set this as a default for a purpose, clear that
  // purpose's default on every other row first. SQLite makes this a 2-stmt
  // dance per purpose; cheap.
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO storage_dirs (id, name, path, purposes, is_default_templates, is_default_isos, is_default_vm_disks, created_at)
      VALUES (?, ?, ?, ?, 0, 0, 0, ?)
    `).run(id, trimmedName, absPath, purposesJson, now);
    if (wantDefaults.templates && input.purposes.includes('templates')) {
      db.prepare('UPDATE storage_dirs SET is_default_templates = 0').run();
      db.prepare('UPDATE storage_dirs SET is_default_templates = 1 WHERE id = ?').run(id);
    }
    if (wantDefaults.isos && input.purposes.includes('isos')) {
      db.prepare('UPDATE storage_dirs SET is_default_isos = 0').run();
      db.prepare('UPDATE storage_dirs SET is_default_isos = 1 WHERE id = ?').run(id);
    }
    if (wantDefaults.vmDisks && input.purposes.includes('vmDisks')) {
      db.prepare('UPDATE storage_dirs SET is_default_vm_disks = 0').run();
      db.prepare('UPDATE storage_dirs SET is_default_vm_disks = 1 WHERE id = ?').run(id);
    }
  });
  tx();

  const dir = (await getDir(id))!;
  await ensurePurposeSubdirs(dir);
  return dir;
}

interface UpdateDirInput {
  name?: string;
  purposes?: StorageDirPurpose[];
  setDefault?: { templates?: boolean; isos?: boolean; vmDisks?: boolean };
}

export async function updateDir(id: string, input: UpdateDirInput): Promise<StorageDir> {
  const existing = await getDir(id);
  if (!existing) throw new ValidationError('id', id, 'not found');

  const db = getDb();
  const tx = db.transaction(() => {
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new ValidationError('name', input.name, 'required');
      if (trimmed.length > 64) throw new ValidationError('name', input.name, 'max 64 chars');
      const dupe = db.prepare('SELECT id FROM storage_dirs WHERE name = ? AND id != ?').get(trimmed, id);
      if (dupe) throw new ValidationError('name', trimmed, 'already in use');
      db.prepare('UPDATE storage_dirs SET name = ? WHERE id = ?').run(trimmed, id);
    }
    if (input.purposes !== undefined) {
      if (input.purposes.length === 0) {
        throw new ValidationError('purposes', input.purposes, 'at least one purpose required');
      }
      // Don't let the operator drop a purpose that's still in use — refuse
      // explicitly so files don't quietly disappear from listings.
      const removed = (['templates', 'isos', 'vmDisks'] as StorageDirPurpose[]).filter(
        (p) => existing.purposes.includes(p) && !input.purposes!.includes(p),
      );
      for (const p of removed) {
        if (p === 'vmDisks') {
          const inUse = db.prepare('SELECT COUNT(*) as c FROM vm_disk_locations WHERE storage_dir_id = ?').get(id) as { c: number };
          if (inUse.c > 0) {
            throw new ValidationError('purposes', p, `vmDisks purpose has ${inUse.c} disk(s) — delete or move them first`);
          }
        }
        // For templates/isos we can detect leftover files but they may belong
        // to the operator from before registration; we don't auto-delete. The
        // listing simply stops showing them once the purpose flag is dropped.
      }
      // If a purpose drops, also clear its default flag.
      const updates: string[] = ['purposes = ?'];
      const args: unknown[] = [purposesToJson(input.purposes)];
      if (!input.purposes.includes('templates')) updates.push('is_default_templates = 0');
      if (!input.purposes.includes('isos')) updates.push('is_default_isos = 0');
      if (!input.purposes.includes('vmDisks')) updates.push('is_default_vm_disks = 0');
      args.push(id);
      db.prepare(`UPDATE storage_dirs SET ${updates.join(', ')} WHERE id = ?`).run(...args);
    }
    const wantDefaults = input.setDefault ?? {};
    const purposesAfter = (input.purposes ?? existing.purposes);
    if (wantDefaults.templates && purposesAfter.includes('templates')) {
      db.prepare('UPDATE storage_dirs SET is_default_templates = 0').run();
      db.prepare('UPDATE storage_dirs SET is_default_templates = 1 WHERE id = ?').run(id);
    }
    if (wantDefaults.isos && purposesAfter.includes('isos')) {
      db.prepare('UPDATE storage_dirs SET is_default_isos = 0').run();
      db.prepare('UPDATE storage_dirs SET is_default_isos = 1 WHERE id = ?').run(id);
    }
    if (wantDefaults.vmDisks && purposesAfter.includes('vmDisks')) {
      db.prepare('UPDATE storage_dirs SET is_default_vm_disks = 0').run();
      db.prepare('UPDATE storage_dirs SET is_default_vm_disks = 1 WHERE id = ?').run(id);
    }
  });
  tx();

  const updated = (await getDir(id))!;
  await ensurePurposeSubdirs(updated);
  return updated;
}

export async function deleteDir(id: string): Promise<void> {
  const dir = await getDir(id);
  if (!dir) throw new ValidationError('id', id, 'not found');
  const db = getDb();

  // Refuse if VM disks still reference this dir.
  const diskCount = (db.prepare('SELECT COUNT(*) as c FROM vm_disk_locations WHERE storage_dir_id = ?').get(id) as { c: number }).c;
  if (diskCount > 0) {
    throw new ValidationError('id', id, `still holds ${diskCount} VM disk(s) — delete or move them first`);
  }
  // Refuse if templates/ISOs still on disk in the relevant subdirs (only
  // counts files matching the listing filters, not arbitrary contents).
  if (dir.purposes.includes('templates')) {
    const sub = getTemplatesSubdir(dir);
    try {
      const files = (await fs.readdir(sub)).filter((f) => f.endsWith('.qcow2') || f.endsWith('.img'));
      if (files.length > 0) {
        throw new ValidationError('id', id, `still holds ${files.length} template(s) — delete them first`);
      }
    } catch (err: unknown) {
      // ENOENT is fine — purpose was set but subdir not yet created.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  if (dir.purposes.includes('isos')) {
    const sub = getIsosSubdir(dir);
    try {
      const files = (await fs.readdir(sub)).filter((f) => f.endsWith('.iso'));
      if (files.length > 0) {
        throw new ValidationError('id', id, `still holds ${files.length} ISO(s) — delete them first`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  db.prepare('DELETE FROM storage_dirs WHERE id = ?').run(id);
}

export async function getDirUsage(dir: StorageDir): Promise<StorageDirUsage> {
  let healthy = true;
  let error: string | undefined;
  let totalBytes = 0;
  let freeBytes = 0;
  let usedByVirtpilotBytes = 0;

  try {
    const stats = await fs.statfs(dir.path);
    totalBytes = stats.blocks * stats.bsize;
    freeBytes = stats.bavail * stats.bsize;
  } catch (err) {
    healthy = false;
    error = err instanceof Error ? err.message : String(err);
    return { totalBytes, freeBytes, usedByVirtpilotBytes, healthy, error };
  }

  // Cheap usage tally: stat every file inside our managed subdirs. For a
  // single-digit number of templates/ISOs/VMs this is fine; if it ever gets
  // expensive we can cache and refresh on a timer.
  const tally = async (subdir: string): Promise<void> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(subdir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(subdir, entry.name);
      if (entry.isDirectory()) {
        await tally(full);
      } else if (entry.isFile()) {
        try {
          const s = await fs.stat(full);
          usedByVirtpilotBytes += s.size;
        } catch {
          // ignore
        }
      }
    }
  };
  if (dir.purposes.includes('templates')) await tally(getTemplatesSubdir(dir));
  if (dir.purposes.includes('isos')) await tally(getIsosSubdir(dir));
  if (dir.purposes.includes('vmDisks')) await tally(getVmDisksSubdir(dir));

  return { totalBytes, freeBytes, usedByVirtpilotBytes, healthy, error };
}

// vm_disk_locations helpers ----------------------------------------------------

export interface DiskLocation {
  vmUuid: string;
  diskFilename: string;
  storageDirId: string;
}

export async function recordDiskLocation(vmUuid: string, diskFilename: string, storageDirId: string): Promise<void> {
  const safeUuid = validateVmUuid(vmUuid);
  const safeFilename = validateFilename(diskFilename);
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO vm_disk_locations (vm_uuid, disk_filename, storage_dir_id)
    VALUES (?, ?, ?)
  `).run(safeUuid, safeFilename, storageDirId);
}

export async function listDiskLocationsForVm(vmUuid: string): Promise<DiskLocation[]> {
  const safeUuid = validateVmUuid(vmUuid);
  const db = getDb();
  const rows = db.prepare(`
    SELECT vm_uuid, disk_filename, storage_dir_id FROM vm_disk_locations WHERE vm_uuid = ?
  `).all(safeUuid) as { vm_uuid: string; disk_filename: string; storage_dir_id: string }[];
  return rows.map((r) => ({ vmUuid: r.vm_uuid, diskFilename: r.disk_filename, storageDirId: r.storage_dir_id }));
}

export async function deleteDiskLocationsForVm(vmUuid: string): Promise<void> {
  const safeUuid = validateVmUuid(vmUuid);
  const db = getDb();
  db.prepare('DELETE FROM vm_disk_locations WHERE vm_uuid = ?').run(safeUuid);
}

export async function deleteDiskLocation(vmUuid: string, diskFilename: string): Promise<void> {
  const safeUuid = validateVmUuid(vmUuid);
  const safeFilename = validateFilename(diskFilename);
  const db = getDb();
  db.prepare('DELETE FROM vm_disk_locations WHERE vm_uuid = ? AND disk_filename = ?').run(safeUuid, safeFilename);
}

export async function listAllDiskLocations(): Promise<DiskLocation[]> {
  const db = getDb();
  const rows = db.prepare('SELECT vm_uuid, disk_filename, storage_dir_id FROM vm_disk_locations').all() as
    { vm_uuid: string; disk_filename: string; storage_dir_id: string }[];
  return rows.map((r) => ({ vmUuid: r.vm_uuid, diskFilename: r.disk_filename, storageDirId: r.storage_dir_id }));
}
