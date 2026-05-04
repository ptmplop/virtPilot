import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { type TraceEntry, execTraced } from './traceService.js';
import { run } from './safeExec.js';
import { validateVmUuid, validateMac } from '../lib/validate.js';

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

// Quote a value as a YAML double-quoted scalar. Escapes the few characters
// YAML treats specially inside "..." and rejects control chars (which would
// otherwise allow newline injection — the operator could craft a hostname
// like `foo\nrunner: rm -rf /` to insert arbitrary cloud-init keys).
function yamlQuote(value: string): string {
  if (typeof value !== 'string') throw new Error('YAML value must be a string');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
    throw new Error('YAML value contains control characters');
  }
  // Escape backslashes and double-quotes only — those are the meaningful
  // metacharacters in a YAML double-quoted scalar.
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function validateHostname(s: unknown): string {
  if (typeof s !== 'string' || s.length === 0 || s.length > 253) {
    throw new Error('Invalid hostname');
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(s)) {
    throw new Error('Invalid hostname format');
  }
  return s;
}

function validateLinuxUser(s: unknown): string {
  if (typeof s !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(s)) {
    throw new Error('Invalid username (must match POSIX user name rules)');
  }
  return s;
}

function validateSshKey(line: string): string {
  // Same anti-injection rules as the dedicated /api/ssh-keys route. Newlines
  // would let an attacker inject `command="..."` lines into authorized_keys.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) throw new Error('SSH key contains control characters');
  if (!/^(ssh-rsa|ssh-dss|ssh-ed25519|ssh-ed448|ecdsa-sha2-nistp(?:256|384|521)|sk-[a-z0-9-]+@openssh\.com) [A-Za-z0-9+/]+={0,2}( [^\r\n]+)?$/.test(line)) {
    throw new Error('Invalid SSH public key format');
  }
  return line;
}

function buildNetworkConfig(nics: NicCloudInit[]): string {
  const lines = ['version: 2', 'ethernets:'];

  nics.forEach((nic, idx) => {
    const key = `eth${idx}`;
    const mac = validateMac(nic.mac);
    lines.push(`  ${key}:`);
    lines.push(`    match:`);
    lines.push(`      macaddress: ${yamlQuote(mac)}`);
    lines.push(`    set-name: ${key}`);

    if (nic.ipConfig.mode === 'dhcp') {
      lines.push(`    dhcp4: true`);
      if (!nic.isPrimary) {
        lines.push(`    dhcp4-overrides:`);
        lines.push(`      route-metric: 200`);
      }
    } else {
      const prefix = Number(nic.ipConfig.prefix);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error('Invalid prefix length');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(nic.ipConfig.ip)) throw new Error('Invalid IPv4');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(nic.ipConfig.gateway)) throw new Error('Invalid gateway');
      lines.push(`    addresses:`);
      lines.push(`      - ${yamlQuote(`${nic.ipConfig.ip}/${prefix}`)}`);
      if (nic.isPrimary) {
        lines.push(`    routes:`);
        lines.push(`      - to: "0.0.0.0/0"`);
        lines.push(`        via: ${yamlQuote(nic.ipConfig.gateway)}`);
      }
      lines.push(`    nameservers:`);
      lines.push(`      addresses:`);
      nic.ipConfig.dns.forEach((d) => {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(d) && !/^[0-9a-fA-F:]+$/.test(d)) throw new Error('Invalid DNS');
        lines.push(`        - ${yamlQuote(d)}`);
      });
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
    await run('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'virtpilot-host']);
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

export async function buildCloudInitIso(vmUuidRaw: string, cfg: CloudInitConfig, trace?: TraceEntry[]): Promise<string> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const hostname = validateHostname(cfg.hostname);
  const username = validateLinuxUser(cfg.username);
  // Password: the cloud-init `chpasswd: list:` block accepts plain text, but
  // we still require it to be free of newlines and control chars so it can't
  // bleed into adjacent YAML keys.
  // eslint-disable-next-line no-control-regex
  if (typeof cfg.password !== 'string' || /[\x00-\x08\x0a-\x1f\x7f]/.test(cfg.password)) {
    throw new Error('Invalid password (contains control characters)');
  }
  const sshKeys = (cfg.sshKeys ?? []).map(validateSshKey);

  const dir = path.join(config.cloudInitDir, vmUuid);
  await fs.mkdir(dir, { recursive: true });

  // instance-id is the UUID — stable across renames so cloud-init never
  // re-runs user-data when the operator changes the VM's friendly name.
  const metaData = `instance-id: ${yamlQuote(vmUuid)}\nlocal-hostname: ${yamlQuote(hostname)}\n`;

  const sshKeyLines = sshKeys.map((k) => `      - ${yamlQuote(k)}`).join('\n');
  const userData = [
    '#cloud-config',
    `hostname: ${yamlQuote(hostname)}`,
    `manage_etc_hosts: true`,
    `users:`,
    `  - name: ${yamlQuote(username)}`,
    `    sudo: ['ALL=(ALL) NOPASSWD:ALL']`,
    `    shell: /bin/sh`,
    `    lock_passwd: false`,
    ...(sshKeyLines ? [`    ssh_authorized_keys:\n${sshKeyLines}`] : []),
    `chpasswd:`,
    `  list: |`,
    `    ${username}:${cfg.password.replace(/[:\\]/g, (c) => '\\' + c)}`,
    `  expire: False`,
    `ssh_pwauth: True`,
    `package_update: false`,
    `runcmd:`,
    `  - sh -c 'command -v bash >/dev/null && chsh -s "$(command -v bash)" ${username} || true'`,
  ].join('\n');

  await fs.writeFile(path.join(dir, 'meta-data'), metaData, 'utf8');
  await fs.writeFile(path.join(dir, 'user-data'), userData, 'utf8');

  const networkConfig = buildNetworkConfig(cfg.nics);
  await fs.writeFile(path.join(dir, 'network-config'), networkConfig, 'utf8');

  const isoPath = path.join(config.cloudInitDir, `${vmUuid}-seed.iso`);
  await execTraced(
    'genisoimage',
    [
      '-output', isoPath,
      '-volid', 'cidata',
      '-joliet',
      '-rock',
      path.join(dir, 'meta-data'),
      path.join(dir, 'user-data'),
      path.join(dir, 'network-config'),
    ],
    trace ?? [],
  );
  return isoPath;
}

// Removes everything we wrote into config.cloudInitDir for this VM.
// Best-effort: missing files are ignored.
export async function deleteCloudInitArtifacts(vmUuidRaw: string): Promise<void> {
  const vmUuid = validateVmUuid(vmUuidRaw);
  const dir = path.join(config.cloudInitDir, vmUuid);
  const seedIso = path.join(config.cloudInitDir, `${vmUuid}-seed.iso`);
  const domainXml = path.join(config.cloudInitDir, `${vmUuid}-domain.xml`);
  await Promise.all([
    fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
    fs.unlink(seedIso).catch(() => {}),
    fs.unlink(domainXml).catch(() => {}),
  ]);
}
