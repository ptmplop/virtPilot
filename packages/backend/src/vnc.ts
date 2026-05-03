import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { virsh } from './services/safeExec.js';
import { validateVmName } from './lib/validate.js';

function pickProtocol(protocols: Set<string>): string | false {
  for (const p of protocols) {
    if (p.startsWith('virtpilot.token.')) return p;
  }
  return false;
}

async function resolveVncPort(vmName: string): Promise<number | null> {
  try {
    const out = await virsh(['vncdisplay', vmName]);
    const match = out.trim().match(/:(\d+)$/);
    if (match) return 5900 + parseInt(match[1], 10);
  } catch { /* VM not running or no VNC */ }
  return null;
}

export function createVncWss(): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    // VNC frames can be large — cap at 8 MB.
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: pickProtocol,
  });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const rawVm = url.searchParams.get('vm');
    let vmName: string;
    try {
      vmName = validateVmName(rawVm);
    } catch {
      ws.close(1008, 'Invalid vm parameter');
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
