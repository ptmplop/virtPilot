import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';

const execAsync = promisify(exec);

async function resolveVncPort(vmName: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`virsh -c ${config.libvirtUri} vncdisplay "${vmName}"`);
    const match = stdout.trim().match(/:(\d+)$/);
    if (match) return 5900 + parseInt(match[1], 10);
  } catch { /* VM not running or no VNC */ }
  return null;
}

export function createVncWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const vmName = url.searchParams.get('vm');

    if (!vmName) {
      ws.close(1008, 'Missing vm parameter');
      return;
    }

    const port = await resolveVncPort(vmName);
    if (!port) {
      ws.close(1011, 'No VNC display found for this VM');
      return;
    }

    const tcp = net.createConnection({ host: '127.0.0.1', port });

    tcp.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });

    tcp.on('error', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'VNC TCP error');
    });

    tcp.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'VNC closed');
    });

    ws.on('message', (data) => {
      if (tcp.writable) tcp.write(data as Buffer);
    });

    ws.on('close', () => tcp.destroy());
    ws.on('error', () => tcp.destroy());
  });

  return wss;
}
