// All process execution funnels through `safeExec.run()` which uses execFile
// with an argument array — never a shell-interpreted command string. This
// service exposes a thin trace-decorating wrapper for command-line operations
// the user can inspect post-mortem.

import { run } from './safeExec.js';

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

// Run a command with array args, recording the invocation in `trace` for
// dashboard display. Use this everywhere we used to call `execTraced(cmd)`
// with a concatenated string.
export async function execTraced(
  file: string,
  args: readonly string[],
  trace: TraceEntry[],
  opts?: { timeout?: number },
): Promise<string> {
  return run(file, args, { timeout: opts?.timeout, trace });
}
