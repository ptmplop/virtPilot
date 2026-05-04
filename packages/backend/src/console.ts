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

    try {
      ptyProcess = pty.spawn('virsh', ['-c', config.libvirtUri, 'console', vmUuid, '--force'], {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd: process.env.HOME ?? '/',
        env: process.env as Record<string, string>,
      });

      ptyProcess.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'Console process exited');
        }
      });

      ws.on('message', (data) => {
        const str = data.toString();
        try {
          const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
          if (msg.type === 'resize' && ptyProcess && msg.cols && msg.rows) {
            ptyProcess.resize(msg.cols, msg.rows);
            return;
          }
        } catch {
          // not JSON — treat as terminal input
        }
        ptyProcess?.write(str);
      });

      ws.on('close', () => {
        ptyProcess?.kill();
        ptyProcess = null;
      });

      ws.on('error', () => {
        ptyProcess?.kill();
        ptyProcess = null;
      });
    } catch (err) {
      ws.send(`\r\nFailed to open console: ${String(err)}\r\n`);
      ws.close(1011, 'Console spawn error');
    }
  });

  return wss;
}
