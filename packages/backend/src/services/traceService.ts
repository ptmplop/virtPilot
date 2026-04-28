import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TraceEntry {
  cmd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function formatTrace(trace: TraceEntry[]): string {
  if (trace.length === 0) return '';
  return trace.map((e) => {
    const parts = [`$ ${e.cmd}`];
    if (e.stdout) parts.push(e.stdout);
    if (e.stderr) parts.push(e.stderr);
    parts.push(`Exit: ${e.exitCode}`);
    return parts.join('\n');
  }).join('\n\n');
}

export async function execTraced(
  cmd: string,
  trace: TraceEntry[],
  opts?: { timeout?: number }
): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(cmd, opts);
    trace.push({ cmd, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    trace.push({
      cmd,
      stdout: e.stdout?.trim() ?? '',
      stderr: e.stderr?.trim() ?? '',
      exitCode: e.code ?? 1,
    });
    throw err;
  }
}
