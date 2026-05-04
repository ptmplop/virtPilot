import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import type { Iso, Template } from '../types.js';
import { type TraceEntry, execTraced } from './traceService.js';
import { validateVmUuid, validateFilename, validatePositiveInt } from '../lib/validate.js';

export async function ensureDirs(): Promise<void> {
  for (const dir of [config.templatesDir, config.isosDir, config.vmsDir, config.cloudInitDir, config.backupRoot]) {
    await fs.mkdir(dir, { recursive: true });
  }
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

export async function setIsoDisplayName(filename: string, name: string): Promise<void> {
  await writeMeta(config.isosDir, validateFilename(path.basename(filename)), { name });
}

export async function setTemplateDisplayName(filename: string, name: string): Promise<void> {
  await writeMeta(config.templatesDir, validateFilename(path.basename(filename)), { name });
}

export async function listTemplates(): Promise<Template[]> {
  await fs.mkdir(config.templatesDir, { recursive: true });
  const files = await fs.readdir(config.templatesDir);
  const templates: Template[] = [];
  for (const file of files.filter((f) => f.endsWith('.qcow2') || f.endsWith('.img'))) {
    const filePath = path.join(config.templatesDir, file);
    const stat = await fs.stat(filePath);
    const meta = await readMeta(config.templatesDir, file);
    templates.push({
      name: meta.name ?? file.replace(/\.(qcow2|img)$/, ''),
      filename: file,
      path: filePath,
      sizeGb: await fileSizeGb(filePath),
      createdAt: stat.birthtime.toISOString(),
    });
  }
  return templates;
}

export async function deleteTemplate(filename: string): Promise<void> {
  const safe = validateFilename(path.basename(filename));
  const filePath = path.join(config.templatesDir, safe);
  await fs.unlink(filePath);
  await deleteMeta(config.templatesDir, safe);
}

export async function listIsos(): Promise<Iso[]> {
  await fs.mkdir(config.isosDir, { recursive: true });
  const files = await fs.readdir(config.isosDir);
  const isos: Iso[] = [];
  for (const file of files.filter((f) => f.endsWith('.iso'))) {
    const filePath = path.join(config.isosDir, file);
    const meta = await readMeta(config.isosDir, file);
    isos.push({
      name: meta.name ?? file.replace(/\.iso$/, ''),
      filename: file,
      path: filePath,
      sizeGb: await fileSizeGb(filePath),
    });
  }
  return isos;
}

export async function deleteIso(filename: string): Promise<void> {
  const safe = validateFilename(path.basename(filename));
  const filePath = path.join(config.isosDir, safe);
  await fs.unlink(filePath);
  await deleteMeta(config.isosDir, safe);
}

export async function createVmDisk(vmUuidRaw: string, templateFilenameRaw: string, diskGbRaw: number, trace?: TraceEntry[]): Promise<string> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const templateFilename = validateFilename(path.basename(templateFilenameRaw));
  const diskGb = validatePositiveInt(diskGbRaw, 65536);
  const templatePath = path.join(config.templatesDir, templateFilename);
  const vmDir = path.join(config.vmsDir, vmUuid);
  await fs.mkdir(vmDir, { recursive: true });
  const diskPath = path.join(vmDir, 'disk.qcow2');
  await execTraced(
    'qemu-img',
    ['create', '-f', 'qcow2', '-b', templatePath, '-F', 'qcow2', '-o', `size=${diskGb}G`, diskPath],
    trace ?? [],
  );
  return diskPath;
}

export async function createBlankPrimaryDisk(vmUuidRaw: string, sizeGbRaw: number, trace?: TraceEntry[]): Promise<string> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const sizeGb = validatePositiveInt(sizeGbRaw, 65536);
  const vmDir = path.join(config.vmsDir, vmUuid);
  await fs.mkdir(vmDir, { recursive: true });
  const diskPath = path.join(vmDir, 'disk.qcow2');
  await execTraced('qemu-img', ['create', '-f', 'qcow2', diskPath, `${sizeGb}G`], trace ?? []);
  return diskPath;
}

export async function createBlankDisk(vmUuidRaw: string, diskIndexRaw: number, sizeGbRaw: number, trace?: TraceEntry[]): Promise<string> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const diskIndex = validatePositiveInt(diskIndexRaw, 64);
  const sizeGb = validatePositiveInt(sizeGbRaw, 65536);
  const vmDir = path.join(config.vmsDir, vmUuid);
  await fs.mkdir(vmDir, { recursive: true });
  const diskPath = path.join(vmDir, `extra-disk-${diskIndex}.qcow2`);
  await execTraced('qemu-img', ['create', '-f', 'qcow2', diskPath, `${sizeGb}G`], trace ?? []);
  return diskPath;
}

export async function deleteVmDir(vmUuid: string): Promise<void> {
  const safe = validateVmUuid(vmUuid);
  const vmDir = path.join(config.vmsDir, safe);
  try {
    await fs.rm(vmDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Marker file inside `${vmsDir}/${uuid}/` that records the VM's user-typed
// name. Operators sshing into the host see UUID-named directories; this lets
// them `cat name.txt` to identify which VM each dir belongs to without going
// through libvirt or the dashboard.
export async function writeVmNameMarker(vmUuidRaw: string, name: string): Promise<void> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const vmDir = path.join(config.vmsDir, vmUuid);
  await fs.mkdir(vmDir, { recursive: true });
  await fs.writeFile(path.join(vmDir, 'name.txt'), name + '\n', 'utf8');
}
