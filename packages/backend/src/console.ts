import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { config } from './config.js';
import { validateVmUuid } from './lib/validate.js';

// Pick the token-bearing subprotocol so the ws library echoes it back in the
// 101 Switching Protocols response. Without this the browser tears the
// connection down with "subprotocol not accepted".
function pickProtocol(protocols: Set<string>): string | false {
  for (const p of protocols) {
    if (p.startsWith('virtpilot.token.')) return p;
  }
  return false;
}

export function createConsoleWss(): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    // Cap to ~1 MB per message — terminal input is tiny, so this just defends
    // against memory exhaustion from a malicious client.
    maxPayload: 1024 * 1024,
    handleProtocols: pickProtocol,
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const rawVm = url.searchParams.get('vm');
    let vmUuid: string;
    try {
      vmUuid = validateVmUuid(rawVm);
    } catch {
      ws.close(1008, 'Invalid vm parameter');
      return;
    }

    let ptyProcess: ReturnType<typeof pty.spawn> | null = null;

    // node-pty's default `kill()` sends SIGHUP, which `virsh console` ignores
    // when blocked in a libvirt RPC — leaving stale `virsh` children attached
    // to the VM's serial PTY across browser refreshes. Send SIGTERM first,
    // then escalate to SIGKILL after a short grace period if it's still alive.
    const reapPty = (proc: ReturnType<typeof pty.spawn> | null): void => {
      if (!proc) return;
      const pid = proc.pid;
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { process.kill(pid, 0); } catch { return; }
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }, 1500).unref();
    };

    try {
      ptyProcess = pty.spawn('virsh', ['-c', config.libvirtUri, 'console', vmUuid, '--force'], {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd: process.env.HOME ?? '/',
        env: process.env as Record<string, string>,
      });

      // Send pty output as binary frames — skips UTF-8 round-trip on both
      // sides; xterm.js writes the raw bytes via the Canvas renderer.
      ptyProcess.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.from(data, 'utf8'), { binary: true });
        }
      });

      ptyProcess.onExit(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'Console process exited');
        }
      });

      // Text frames carry JSON control messages (resize, ping); binary frames
      // carry raw keystrokes. Distinguishing prevents a pasted JSON-looking
      // string from accidentally triggering a pty resize.
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          const str = (data as Buffer).toString();
          try {
            const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
            if (msg.type === 'resize' && ptyProcess && msg.cols && msg.rows) {
              ptyProcess.resize(msg.cols, msg.rows);
              return;
            }
            if (msg.type === 'ping') return;
          } catch { /* fall through and treat as input */ }
          ptyProcess?.write(str);
          return;
        }
        ptyProcess?.write((data as Buffer).toString());
      });

      ws.on('close', () => {
        reapPty(ptyProcess);
        ptyProcess = null;
      });

      ws.on('error', () => {
        reapPty(ptyProcess);
        ptyProcess = null;
      });
    } catch (err) {
      ws.send(`\r\nFailed to open console: ${String(err)}\r\n`);
      ws.close(1011, 'Console spawn error');
    }
  });

  return wss;
}
