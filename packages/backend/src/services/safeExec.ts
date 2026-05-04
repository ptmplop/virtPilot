// Safe process execution helpers. ALWAYS pass arguments as an array; never
// build a shell command string from user input. This module is the single
// boundary where child processes start, so a future audit only has to read
// here to trust the rest of the codebase.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';
import type { TraceEntry } from './traceService.js';

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number; encoding?: BufferEncoding; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

interface RunOpts { timeout?: number; maxBuffer?: number; cwd?: string; trace?: TraceEntry[] }

// Render a stable trace line. Quote any arg containing whitespace or shell
// metacharacters so the trace reads as the operator typed it, but the actual
// invocation always uses the array — quoting here is cosmetic.
function renderCmd(file: string, args: readonly string[]): string {
  const parts = [file, ...args.map((a) => /[^\w@%+=:,./-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)];
  return parts.join(' ');
}

export async function run(file: string, args: readonly string[], opts: RunOpts = {}): Promise<string> {
  const cmd = renderCmd(file, args);
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      cwd: opts.cwd,
    });
    const out = String(stdout).trim();
    const err = String(stderr).trim();
    if (opts.trace) opts.trace.push({ cmd, stdout: out, stderr: err, exitCode: 0 });
    return out;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (opts.trace) {
      opts.trace.push({
        cmd,
        stdout: e.stdout?.toString().trim() ?? '',
        stderr: e.stderr?.toString().trim() ?? e.message ?? '',
        exitCode: typeof e.code === 'number' ? e.code : 1,
      });
    }
    throw err;
  }
}

// virsh wrapper — prepends `-c <libvirtUri>` so callers don't have to.
export async function virsh(args: readonly string[], opts: RunOpts = {}): Promise<string> {
  return run('virsh', ['-c', config.libvirtUri, ...args], { timeout: 30_000, ...opts });
}

// Convenience wrapper for the legacy "swallow all errors" callers.
export async function runSafe(file: string, args: readonly string[], opts: RunOpts = {}): Promise<string | null> {
  try {
    return await run(file, args, opts);
  } catch {
    return null;
  }
}

// Privileged commands run via sudo so the install.sh sudoers rules are the
// single source of truth on what the unprivileged service is allowed to do
// as root. Use sparingly — most things should run unprivileged.
export async function sudo(file: string, args: readonly string[], opts: RunOpts = {}): Promise<string> {
  return run('sudo', ['-n', file, ...args], opts);
}

export async function sudoSafe(file: string, args: readonly string[], opts: RunOpts = {}): Promise<string | null> {
  return runSafe('sudo', ['-n', file, ...args], opts);
}

// qemu-img wrapper that runs as libvirt-qemu via sudo. Required because
// libvirt's `dynamic_ownership=1` chowns VM disk files to libvirt-qemu when
// the domain starts (mode 0644 for the active disk, 0600 for snapshot
// overlays), so the unprivileged backend user can't write — and can't even
// read the 0600 overlay files. The sudoers rule in install.sh grants
// `virtpilot ALL=(libvirt-qemu) NOPASSWD: /usr/bin/qemu-img`, scoped to
// exactly this binary.
//
// Use this for any qemu-img call that touches an existing VM disk
// (everything under `${vmsDir}/${uuid}/`). Fresh-create calls in storageService
// don't need it — they write a brand-new file alongside virtpilot-owned
// templates.
export async function qemuImg(args: readonly string[], opts: RunOpts = {}): Promise<string> {
  return run('sudo', ['-n', '-u', 'libvirt-qemu', '/usr/bin/qemu-img', ...args], opts);
}
