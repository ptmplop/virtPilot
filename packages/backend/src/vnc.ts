import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { virsh } from './services/safeExec.js';
import { validateVmUuid } from './lib/validate.js';

// Liveness flag hung off each socket by the heartbeat below.
type AliveSocket = WebSocket & { isAlive?: boolean };

function pickProtocol(protocols: Set<string>): string | false {
  for (const p of protocols) {
    if (p.startsWith('virtpilot.token.')) return p;
  }
  return false;
}

async function resolveVncPort(vmUuid: string): Promise<number | null> {
  try {
    const out = await virsh(['vncdisplay', vmUuid]);
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

  // ws disables the socket timeout, so a client that disappears without a FIN
  // (laptop lid, dropped Wi-Fi, NAT timeout) would hold the QEMU VNC socket
  // open forever — and QEMU only allows one. Ping every 30s and drop anyone
  // who misses a pong.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const client = socket as AliveSocket;
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', async (socket, req) => {
    const ws = socket as AliveSocket;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const url = new URL(req.url ?? '', 'http://localhost');
    const rawVm = url.searchParams.get('vm');
    let vmUuid: string;
    try {
      vmUuid = validateVmUuid(rawVm);
    } catch {
      ws.close(1008, 'Invalid vm parameter');
      return;
    }

    // The socket is open and parsing frames the moment the port lookup below
    // yields, so teardown has to be wired up before the await: a malformed
    // frame emitting 'error' with no listener would take the whole process
    // down (killing every other live session), and a client that vanishes
    // mid-lookup would never fire 'close', leaking the QEMU socket and
    // blocking every future VNC session for that VM.
    let closed = false;
    let tcp: net.Socket | null = null;
    const teardown = (): void => {
      closed = true;
      tcp?.destroy();
    };
    ws.on('close', teardown);
    ws.on('error', teardown);

    const port = await resolveVncPort(vmUuid);
    if (!port) {
      ws.close(1011, 'No VNC display found for this VM');
      return;
    }

    // The client may have gone away while we were resolving the display —
    // don't take QEMU's single VNC slot for a session nobody is watching.
    if (closed || ws.readyState !== WebSocket.OPEN) return;

    const conn = net.createConnection({ host: '127.0.0.1', port });
    tcp = conn;

    conn.on('data', (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });

    conn.on('error', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'VNC TCP error');
    });

    conn.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'VNC closed');
    });

    ws.on('message', (data) => {
      if (conn.writable) conn.write(data as Buffer);
    });
  });

  return wss;
}
