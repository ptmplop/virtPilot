import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import type { Iso, Template } from '../types.js';
import { type TraceEntry, execTraced } from './traceService.js';
import { validateVmUuid, validateFilename, validatePositiveInt } from '../lib/validate.js';
import * as storageDirService from './storageDirService.js';
import type { StorageDir } from './storageDirService.js';

// Directories that aren't part of the storage-dir abstraction — they always
// live on the system root because libvirt needs them present even if a
// non-default storage dir's mount disappears (cloud-init seed.iso) or because
// they hold cross-VM state (backups, virtpilot.db, upload scratch).
export async function ensureSystemDirs(): Promise<void> {
  // 0770 lets libvirt-qemu (a member of the virtpilot group) write into these
  // dirs. The parent /var/lib/virtpilot stays 0750 (set by install.sh) so the
  // group can still traverse but can't see siblings.
  const scratchDir = path.join(config.storageRoot, '.uploads');
  for (const dir of [config.vmsDir, config.cloudInitDir, config.backupRoot, scratchDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o770).catch(() => { /* unprivileged user can't chmod parent — install.sh sets it up */ });
  }
}

// Kept for API compatibility with callers that just want "make sure all the
// dirs we need exist" without caring about which abstraction owns each one.
export async function ensureDirs(): Promise<void> {
  await ensureSystemDirs();
}

async function fileSizeGb(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return Math.round((stat.size / 1073741824) * 100) / 100;
}

async function readMeta(dir: string, filename: string): Promise<{ name?: string }> {
  try {
    const raw = await fs.readFile(path.join(dir, `${filename}.meta.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeMeta(dir: string, filename: string, meta: { name: string }): Promise<void> {
  await fs.writeFile(path.join(dir, `${filename}.meta.json`), JSON.stringify(meta), 'utf8');
}

async function deleteMeta(dir: string, filename: string): Promise<void> {
  try {
    await fs.unlink(path.join(dir, `${filename}.meta.json`));
  } catch {
    // ignore — meta file may not exist
  }
}

// Look up which storage dir holds a given filename for a given purpose. If the
// caller passes the storage dir explicitly we use it; otherwise we walk every
// dir flagged for the purpose and take the first hit. Returns null if not found.
async function findFileLocation(
  filename: string,
  subdirOf: (dir: StorageDir) => string,
  purpose: 'templates' | 'isos',
): Promise<{ dir: StorageDir; absPath: string } | null> {
  const dirs = await storageDirService.getDirsForPurpose(purpose);
  for (const dir of dirs) {
    const candidate = path.join(subdirOf(dir), filename);
    try {
      await fs.access(candidate);
      return { dir, absPath: candidate };
    } catch {
      // not in this dir — try next
    }
  }
  return null;
}

export async function setIsoDisplayName(filename: string, name: string): Promise<void> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getIsosSubdir, 'isos');
  if (!found) throw new Error(`ISO "${safe}" not found in any storage dir`);
  await writeMeta(storageDirService.getIsosSubdir(found.dir), safe, { name });
}

export async function setTemplateDisplayName(filename: string, name: string): Promise<void> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getTemplatesSubdir, 'templates');
  if (!found) throw new Error(`Template "${safe}" not found in any storage dir`);
  await writeMeta(storageDirService.getTemplatesSubdir(found.dir), safe, { name });
}

export async function listTemplates(): Promise<Template[]> {
  const dirs = await storageDirService.getDirsForPurpose('templates');
  const templates: Template[] = [];
  for (const dir of dirs) {
    const subdir = storageDirService.getTemplatesSubdir(dir);
    let files: string[];
    try {
      await fs.mkdir(subdir, { recursive: true });
      files = await fs.readdir(subdir);
    } catch {
      // Mount likely missing — skip the dir rather than failing the whole list.
      continue;
    }
    for (const file of files.filter((f) => f.endsWith('.qcow2') || f.endsWith('.img'))) {
      const filePath = path.join(subdir, file);
      try {
        const stat = await fs.stat(filePath);
        const meta = await readMeta(subdir, file);
        templates.push({
          name: meta.name ?? file.replace(/\.(qcow2|img)$/, ''),
          filename: file,
          path: filePath,
          sizeGb: await fileSizeGb(filePath),
          createdAt: stat.birthtime.toISOString(),
          storageDirId: dir.id,
          storageDirName: dir.name,
        });
      } catch {
        // file vanished between readdir and stat — skip
      }
    }
  }
  return templates;
}

export async function deleteTemplate(filename: string): Promise<void> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getTemplatesSubdir, 'templates');
  if (!found) throw new Error(`Template "${safe}" not found in any storage dir`);
  await fs.unlink(found.absPath);
  await deleteMeta(storageDirService.getTemplatesSubdir(found.dir), safe);
}

// Resolve a template to its absolute path on disk. Used by VM create to point
// `qemu-img create -b` at the right backing file.
export async function resolveTemplatePath(filename: string): Promise<string> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getTemplatesSubdir, 'templates');
  if (!found) throw new Error(`Template "${safe}" not found`);
  return found.absPath;
}

export async function resolveIsoPath(filename: string): Promise<string> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getIsosSubdir, 'isos');
  if (!found) throw new Error(`ISO "${safe}" not found`);
  return found.absPath;
}

export async function listIsos(): Promise<Iso[]> {
  const dirs = await storageDirService.getDirsForPurpose('isos');
  const isos: Iso[] = [];
  for (const dir of dirs) {
    const subdir = storageDirService.getIsosSubdir(dir);
    let files: string[];
    try {
      await fs.mkdir(subdir, { recursive: true });
      files = await fs.readdir(subdir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith('.iso'))) {
      const filePath = path.join(subdir, file);
      try {
        const meta = await readMeta(subdir, file);
        isos.push({
          name: meta.name ?? file.replace(/\.iso$/, ''),
          filename: file,
          path: filePath,
          sizeGb: await fileSizeGb(filePath),
          storageDirId: dir.id,
          storageDirName: dir.name,
        });
      } catch {
        // file vanished — skip
      }
    }
  }
  return isos;
}

export async function deleteIso(filename: string): Promise<void> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getIsosSubdir, 'isos');
  if (!found) throw new Error(`ISO "${safe}" not found in any storage dir`);
  await fs.unlink(found.absPath);
  await deleteMeta(storageDirService.getIsosSubdir(found.dir), safe);
}

// Pick the storage dir to use for a VM disk creation. Caller passes an explicit
// id when known (operator-selected); otherwise we fall back to the default
// vmDisks dir. Throws if no suitable dir exists or the chosen one isn't
// flagged for vmDisks.
async function resolveVmDiskDir(storageDirIdOpt: string | undefined): Promise<StorageDir> {
  if (storageDirIdOpt) {
    const dir = await storageDirService.getDir(storageDirIdOpt);
    if (!dir) throw new Error(`Storage directory ${storageDirIdOpt} not found`);
    if (!dir.purposes.includes('vmDisks')) {
      throw new Error(`Storage directory "${dir.name}" is not flagged for VM disks`);
    }
    return dir;
  }
  const fallback = await storageDirService.getDefaultDirFor('vmDisks');
  if (!fallback) throw new Error('No storage directory available for VM disks');
  return fallback;
}

async function ensureVmDiskFolder(dir: StorageDir, vmUuid: string): Promise<string> {
  const folder = path.join(storageDirService.getVmDisksSubdir(dir), vmUuid);
  await fs.mkdir(folder, { recursive: true });
  await fs.chmod(folder, 0o770).catch(() => {});
  return folder;
}

export async function createVmDisk(
  vmUuidRaw: string,
  templateFilenameRaw: string,
  diskGbRaw: number,
  storageDirId: string | undefined,
  trace?: TraceEntry[],
): Promise<string> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const templateFilename = validateFilename(path.basename(templateFilenameRaw));
  const diskGb = validatePositiveInt(diskGbRaw, 65536);
  const templatePath = await resolveTemplatePath(templateFilename);
  const dir = await resolveVmDiskDir(storageDirId);
  const folder = await ensureVmDiskFolder(dir, vmUuid);
  const diskPath = path.join(folder, 'disk.qcow2');
  await execTraced(
    'qemu-img',
    ['create', '-f', 'qcow2', '-b', templatePath, '-F', 'qcow2', '-o', `size=${diskGb}G`, diskPath],
    trace ?? [],
  );
  await storageDirService.recordDiskLocation(vmUuid, 'disk.qcow2', dir.id);
  return diskPath;
}

export async function createBlankPrimaryDisk(
  vmUuidRaw: string,
  sizeGbRaw: number,
  storageDirId: string | undefined,
  trace?: TraceEntry[],
): Promise<string> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const sizeGb = validatePositiveInt(sizeGbRaw, 65536);
  const dir = await resolveVmDiskDir(storageDirId);
  const folder = await ensureVmDiskFolder(dir, vmUuid);
  const diskPath = path.join(folder, 'disk.qcow2');
  await execTraced('qemu-img', ['create', '-f', 'qcow2', diskPath, `${sizeGb}G`], trace ?? []);
  await storageDirService.recordDiskLocation(vmUuid, 'disk.qcow2', dir.id);
  return diskPath;
}

export async function createBlankDisk(
  vmUuidRaw: string,
  diskIndexRaw: number,
  sizeGbRaw: number,
  storageDirId: string | undefined,
  trace?: TraceEntry[],
): Promise<string> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const diskIndex = validatePositiveInt(diskIndexRaw, 64);
  const sizeGb = validatePositiveInt(sizeGbRaw, 65536);
  const dir = await resolveVmDiskDir(storageDirId);
  const folder = await ensureVmDiskFolder(dir, vmUuid);
  const filename = `extra-disk-${diskIndex}.qcow2`;
  const diskPath = path.join(folder, filename);
  await execTraced('qemu-img', ['create', '-f', 'qcow2', diskPath, `${sizeGb}G`], trace ?? []);
  await storageDirService.recordDiskLocation(vmUuid, filename, dir.id);
  return diskPath;
}

// Walk every recorded disk location for the VM, delete the file, and clean up
// any now-empty per-VM folders + the system-root vmDir (NVRAM, name.txt).
export async function deleteVmDir(vmUuid: string): Promise<void> {
  const safe = validateVmUuid(vmUuid);
  const locations = await storageDirService.listDiskLocationsForVm(safe);
  const visitedFolders = new Set<string>();

  for (const loc of locations) {
    const dir = await storageDirService.getDir(loc.storageDirId);
    if (!dir) continue;
    const folder = path.join(storageDirService.getVmDisksSubdir(dir), safe);
    visitedFolders.add(folder);
    const filePath = path.join(folder, loc.diskFilename);
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore — file may already be gone
    }
  }
  await storageDirService.deleteDiskLocationsForVm(safe);

  for (const folder of visitedFolders) {
    try {
      await fs.rm(folder, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // System-root vmDir holds NVRAM + name.txt; always wipe it on VM delete.
  const systemVmDir = path.join(config.vmsDir, safe);
  try {
    await fs.rm(systemVmDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// NVRAM and name.txt live on the system root, not on a registered storage
// dir. Keeping these on local disk means the VM can still boot if a non-default
// storage dir's mount disappears (libvirt would still fail to open the disk
// itself, but the firmware/UEFI plumbing won't be the failure point).
export function getSystemVmDir(vmUuid: string): string {
  const safe = validateVmUuid(vmUuid);
  return path.join(config.vmsDir, safe);
}

export async function ensureSystemVmDir(vmUuid: string): Promise<string> {
  const dir = getSystemVmDir(vmUuid);
  await fs.mkdir(dir, { recursive: true });
  await fs.chmod(dir, 0o770).catch(() => {});
  return dir;
}

// Marker file that records the VM's user-typed name. Operators sshing into the
// host see UUID-named directories; this lets them `cat name.txt` to identify
// which VM each dir belongs to without going through libvirt or the dashboard.
export async function writeVmNameMarker(vmUuidRaw: string, name: string): Promise<void> {
  const dir = await ensureSystemVmDir(vmUuidRaw);
  await fs.writeFile(path.join(dir, 'name.txt'), name + '\n', 'utf8');
}

// Move helpers ----------------------------------------------------------------

// Cross-filesystem-aware move: a registered storage dir might be on a separate
// mount from the source, in which case fs.rename throws EXDEV and we have to
// fall through to copy + unlink. Both legs throw on error — caller handles
// rollback at a higher level.
async function moveCrossFs(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

// Move the optional `.meta.json` sidecar (display name) alongside its file.
// Best-effort: the qcow2/ISO has already moved by the time we call this, so
// re-throwing on a hard failure here would leave the operator with an
// inconsistent state (file moved, meta orphaned, listing throws on read).
// Instead, log to stderr and let the listing fall back to the filename-as-
// display-name behaviour. ENOENT is the common case and silent.
async function moveMetaIfPresent(srcDir: string, destDir: string, filename: string): Promise<void> {
  const srcMeta = path.join(srcDir, `${filename}.meta.json`);
  const destMeta = path.join(destDir, `${filename}.meta.json`);
  try {
    await moveCrossFs(srcMeta, destMeta);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn(`[storage] meta-move failed for ${filename}: ${String(err)} — display name may revert to filename`);
  }
}

interface MoveResult {
  oldPath: string;
  newPath: string;
  fromDir: StorageDir;
  toDir: StorageDir;
}

async function resolveMoveTarget(
  storageDirId: string,
  purpose: 'templates' | 'isos' | 'vmDisks',
): Promise<StorageDir> {
  const dir = await storageDirService.getDir(storageDirId);
  if (!dir) throw new Error(`Storage directory ${storageDirId} not found`);
  if (!dir.purposes.includes(purpose)) {
    throw new Error(`Storage directory "${dir.name}" is not flagged for ${purpose}`);
  }
  return dir;
}

export async function moveTemplate(filename: string, targetStorageDirId: string): Promise<MoveResult> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getTemplatesSubdir, 'templates');
  if (!found) throw new Error(`Template "${safe}" not found in any storage dir`);
  const targetDir = await resolveMoveTarget(targetStorageDirId, 'templates');
  if (targetDir.id === found.dir.id) {
    throw new Error(`Template "${safe}" is already in "${targetDir.name}"`);
  }
  const srcSubdir = storageDirService.getTemplatesSubdir(found.dir);
  const destSubdir = storageDirService.getTemplatesSubdir(targetDir);
  await fs.mkdir(destSubdir, { recursive: true });
  await fs.chmod(destSubdir, 0o770).catch(() => {});
  const newPath = path.join(destSubdir, safe);
  // Refuse if a file with the same name already exists at the destination —
  // overwriting could clobber a different operator's template.
  try {
    await fs.access(newPath);
    throw new Error(`A template named "${safe}" already exists in "${targetDir.name}"`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await moveCrossFs(found.absPath, newPath);
  await moveMetaIfPresent(srcSubdir, destSubdir, safe);
  return { oldPath: found.absPath, newPath, fromDir: found.dir, toDir: targetDir };
}

export async function moveIso(filename: string, targetStorageDirId: string): Promise<MoveResult> {
  const safe = validateFilename(path.basename(filename));
  const found = await findFileLocation(safe, storageDirService.getIsosSubdir, 'isos');
  if (!found) throw new Error(`ISO "${safe}" not found in any storage dir`);
  const targetDir = await resolveMoveTarget(targetStorageDirId, 'isos');
  if (targetDir.id === found.dir.id) {
    throw new Error(`ISO "${safe}" is already in "${targetDir.name}"`);
  }
  const srcSubdir = storageDirService.getIsosSubdir(found.dir);
  const destSubdir = storageDirService.getIsosSubdir(targetDir);
  await fs.mkdir(destSubdir, { recursive: true });
  await fs.chmod(destSubdir, 0o770).catch(() => {});
  const newPath = path.join(destSubdir, safe);
  try {
    await fs.access(newPath);
    throw new Error(`An ISO named "${safe}" already exists in "${targetDir.name}"`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await moveCrossFs(found.absPath, newPath);
  await moveMetaIfPresent(srcSubdir, destSubdir, safe);
  return { oldPath: found.absPath, newPath, fromDir: found.dir, toDir: targetDir };
}

export interface VmDiskMovePlan {
  vmUuid: string;
  diskFilename: string;
  oldPath: string;
  newPath: string;
  fromDir: StorageDir;
  toDir: StorageDir;
}

// Plan a VM disk move without touching the file or the DB. Used by the route
// layer to pre-validate the move (compute paths, then dry-run the libvirt XML
// rewrite) before any state changes. Throws on validation failures so the
// route can return 4xx without partial state.
export async function planVmDiskMove(
  vmUuid: string,
  diskFilename: string,
  targetStorageDirId: string,
): Promise<VmDiskMovePlan> {
  const safeUuid = validateVmUuid(vmUuid);
  const safeFilename = validateFilename(path.basename(diskFilename));

  const locations = await storageDirService.listDiskLocationsForVm(safeUuid);
  const loc = locations.find((l) => l.diskFilename === safeFilename);
  if (!loc) throw new Error(`Disk ${safeFilename} for VM ${safeUuid} not tracked`);

  const fromDir = await storageDirService.getDir(loc.storageDirId);
  if (!fromDir) throw new Error(`Source storage directory missing`);
  const toDir = await resolveMoveTarget(targetStorageDirId, 'vmDisks');
  if (toDir.id === fromDir.id) {
    throw new Error(`Disk is already in "${toDir.name}"`);
  }

  const srcFolder = path.join(storageDirService.getVmDisksSubdir(fromDir), safeUuid);
  const destFolder = path.join(storageDirService.getVmDisksSubdir(toDir), safeUuid);
  const oldPath = path.join(srcFolder, safeFilename);
  const newPath = path.join(destFolder, safeFilename);

  try {
    await fs.access(oldPath);
  } catch {
    throw new Error(`Disk file missing on disk: ${oldPath}`);
  }
  try {
    await fs.access(newPath);
    throw new Error(`A disk named "${safeFilename}" already exists at the destination`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return { vmUuid: safeUuid, diskFilename: safeFilename, oldPath, newPath, fromDir, toDir };
}

// Execute a previously-planned move: physical file move + DB row update +
// empty-folder cleanup. Caller wraps libvirt-XML side effects around this so
// failures can be rolled back via rollbackVmDiskMove.
export async function executeVmDiskMove(plan: VmDiskMovePlan): Promise<void> {
  const destFolder = path.dirname(plan.newPath);
  await fs.mkdir(destFolder, { recursive: true });
  await fs.chmod(destFolder, 0o770).catch(() => {});

  await moveCrossFs(plan.oldPath, plan.newPath);
  try {
    await storageDirService.recordDiskLocation(plan.vmUuid, plan.diskFilename, plan.toDir.id);
  } catch (err) {
    // SQL write failed after file move — undo the move so the caller can
    // surface a clean failure rather than leaving the disk untracked.
    await moveCrossFs(plan.newPath, plan.oldPath).catch(() => { /* best-effort */ });
    throw err;
  }

  // Source folder cleanup is best-effort — losing the empty dir is fine.
  const srcFolder = path.dirname(plan.oldPath);
  try {
    const remaining = await fs.readdir(srcFolder);
    if (remaining.length === 0) await fs.rmdir(srcFolder);
  } catch { /* ignore */ }
}

// Reverse a successfully-executed move. Used when domain XML application
// fails after the file + DB have already been updated.
export async function rollbackVmDiskMove(plan: VmDiskMovePlan): Promise<void> {
  const srcFolder = path.dirname(plan.oldPath);
  await fs.mkdir(srcFolder, { recursive: true });
  await fs.chmod(srcFolder, 0o770).catch(() => {});
  await moveCrossFs(plan.newPath, plan.oldPath);
  await storageDirService.recordDiskLocation(plan.vmUuid, plan.diskFilename, plan.fromDir.id);
  // Try to drop the now-empty destination folder.
  const destFolder = path.dirname(plan.newPath);
  try {
    const remaining = await fs.readdir(destFolder);
    if (remaining.length === 0) await fs.rmdir(destFolder);
  } catch { /* ignore */ }
}
