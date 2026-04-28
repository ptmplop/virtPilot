import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const storageRoot = process.env.STORAGE_ROOT ?? '/var/lib/virtpilot';

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  storageRoot,
  templatesDir: process.env.TEMPLATES_DIR ?? path.join(storageRoot, 'templates'),
  isosDir: process.env.ISOS_DIR ?? path.join(storageRoot, 'isos'),
  vmsDir: process.env.VMS_DIR ?? path.join(storageRoot, 'vms'),
  cloudInitDir: process.env.CLOUD_INIT_DIR ?? path.join(storageRoot, 'cloud-init'),
  defaultBridge: process.env.DEFAULT_BRIDGE ?? 'br0',
  libvirtUri: process.env.LIBVIRT_URI ?? 'qemu:///system',
  authPassword: process.env.AUTH_PASSWORD ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
};
