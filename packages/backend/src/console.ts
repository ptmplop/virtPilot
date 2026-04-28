import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { config } from './config.js';

export function createConsoleWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const vmName = url.searchParams.get('vm');

    if (!vmName) {
      ws.close(1008, 'Missing vm parameter');
      return;
    }

    let ptyProcess: ReturnType<typeof pty.spawn> | null = null;

    try {
      ptyProcess = pty.spawn('virsh', ['-c', config.libvirtUri, 'console', vmName, '--force'], {
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
