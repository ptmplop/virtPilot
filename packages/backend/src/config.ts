import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

// Read version from this package's package.json so it stays in lock-step
// with the version-bump checklist (no manual update needed here).
function readVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();

const storageRoot = process.env.STORAGE_ROOT ?? '/var/lib/virtpilot';

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  storageRoot,
  templatesDir: process.env.TEMPLATES_DIR ?? path.join(storageRoot, 'templates'),
  isosDir: process.env.ISOS_DIR ?? path.join(storageRoot, 'isos'),
  vmsDir: process.env.VMS_DIR ?? path.join(storageRoot, 'vms'),
  cloudInitDir: process.env.CLOUD_INIT_DIR ?? path.join(storageRoot, 'cloud-init'),
  backupRoot: process.env.BACKUP_ROOT ?? path.join(storageRoot, 'backups'),
  defaultBridge: process.env.DEFAULT_BRIDGE ?? 'br0',
  libvirtUri: process.env.LIBVIRT_URI ?? 'qemu:///system',
  // Repo root for the self-upgrade flow. Falls back to process.cwd() so dev
  // workflows (where the systemd unit isn't running) still work.
  repoDir: process.env.VIRTPILOT_REPO_DIR ?? process.cwd(),
  authPassword: process.env.AUTH_PASSWORD ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
};
