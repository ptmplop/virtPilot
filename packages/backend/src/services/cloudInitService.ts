import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';
import { type TraceEntry, execTraced } from './traceService.js';

const execAsync = promisify(exec);

export type NicIpConfig =
  | { mode: 'dhcp' }
  | { mode: 'static'; ip: string; prefix: number; gateway: string; dns: string[] };

export interface NicCloudInit {
  mac: string;
  ipConfig: NicIpConfig;
  isPrimary: boolean;
}

interface CloudInitConfig {
  hostname: string;
  username: string;
  password: string;
  sshKeys?: string[];
  nics: NicCloudInit[];
}

function buildNetworkConfig(nics: NicCloudInit[]): string {
  const lines = ['version: 2', 'ethernets:'];

  nics.forEach((nic, idx) => {
    const key = `eth${idx}`;
    lines.push(`  ${key}:`);
    lines.push(`    match:`);
    lines.push(`      macaddress: "${nic.mac}"`);
    lines.push(`    set-name: ${key}`);

    if (nic.ipConfig.mode === 'dhcp') {
      lines.push(`    dhcp4: true`);
      if (!nic.isPrimary) {
        // Deprioritise default route from non-primary DHCP interfaces
        lines.push(`    dhcp4-overrides:`);
        lines.push(`      route-metric: 200`);
      }
    } else {
      lines.push(`    addresses:`);
      lines.push(`      - ${nic.ipConfig.ip}/${nic.ipConfig.prefix}`);
      if (nic.isPrimary) {
        lines.push(`    routes:`);
        lines.push(`      - to: 0.0.0.0/0`);
        lines.push(`        via: ${nic.ipConfig.gateway}`);
      }
      lines.push(`    nameservers:`);
      lines.push(`      addresses:`);
      nic.ipConfig.dns.forEach((d) => lines.push(`        - ${d}`));
    }
  });

  return lines.join('\n');
}

export async function ensureHostSshKeypair(): Promise<string | null> {
  const home = process.env.HOME ?? '/root';
  const sshDir = path.join(home, '.ssh');
  const keyPath = path.join(sshDir, 'id_ed25519');

  try {
    await fs.access(keyPath);
    return keyPath;
  } catch { /* not found — generate */ }

  await fs.mkdir(sshDir, { recursive: true });
  try { await fs.chmod(sshDir, 0o700); } catch { /* ignore */ }

  try {
    await execAsync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "virtpilot-host"`);
    return keyPath;
  } catch (err) {
    console.error('Failed to generate SSH keypair:', err);
    return null;
  }
}

export async function getHostSshPublicKey(): Promise<string | null> {
  const keyPath = await ensureHostSshKeypair();
  if (!keyPath) return null;
  try {
    return (await fs.readFile(`${keyPath}.pub`, 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function buildCloudInitIso(vmName: string, cfg: CloudInitConfig, trace?: TraceEntry[]): Promise<string> {
  const dir = path.join(config.cloudInitDir, vmName);
  await fs.mkdir(dir, { recursive: true });

  const metaData = `instance-id: ${vmName}\nlocal-hostname: ${cfg.hostname}\n`;

  const sshKeyLines = (cfg.sshKeys ?? []).map((k) => `      - ${k}`).join('\n');
  const userData = [
    '#cloud-config',
    `hostname: ${cfg.hostname}`,
    `manage_etc_hosts: true`,
    `users:`,
    `  - name: ${cfg.username}`,
    `    sudo: ['ALL=(ALL) NOPASSWD:ALL']`,
    `    shell: /bin/bash`,
    `    lock_passwd: false`,
    ...(sshKeyLines ? [`    ssh_authorized_keys:\n${sshKeyLines}`] : []),
    `chpasswd:`,
    `  list: |`,
    `    ${cfg.username}:${cfg.password}`,
    `  expire: False`,
    `ssh_pwauth: True`,
    `package_update: false`,
  ].join('\n');

  await fs.writeFile(path.join(dir, 'meta-data'), metaData, 'utf8');
  await fs.writeFile(path.join(dir, 'user-data'), userData, 'utf8');

  const networkConfig = buildNetworkConfig(cfg.nics);
  await fs.writeFile(path.join(dir, 'network-config'), networkConfig, 'utf8');

  const isoPath = path.join(config.cloudInitDir, `${vmName}-seed.iso`);
  await execTraced(
    `genisoimage -output ${isoPath} -volid cidata -joliet -rock ${dir}/meta-data ${dir}/user-data ${dir}/network-config`,
    trace ?? []
  );
  return isoPath;
}

// Removes everything we wrote into config.cloudInitDir for this VM:
//   - {cloudInitDir}/{vmName}/                  (meta-data, user-data, network-config)
//   - {cloudInitDir}/{vmName}-seed.iso          (built by buildCloudInitIso)
//   - {cloudInitDir}/{vmName}-domain.xml        (written by vms.ts on create, before `virsh define`)
// Best-effort: missing files are ignored.
export async function deleteCloudInitArtifacts(vmName: string): Promise<void> {
  const dir = path.join(config.cloudInitDir, vmName);
  const seedIso = path.join(config.cloudInitDir, `${vmName}-seed.iso`);
  const domainXml = path.join(config.cloudInitDir, `${vmName}-domain.xml`);
  await Promise.all([
    fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
    fs.unlink(seedIso).catch(() => {}),
    fs.unlink(domainXml).catch(() => {}),
  ]);
}
