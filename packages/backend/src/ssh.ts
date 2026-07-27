import { WebSocketServer, WebSocket } from 'ws';
import { Client as SshClient, type ClientChannel } from 'ssh2';
import fs from 'fs/promises';
import * as vmMetaService from './services/vmMetaService.js';
import { ensureHostSshKeypair } from './services/cloudInitService.js';
import { virsh } from './services/safeExec.js';
import { validateVmUuid } from './lib/validate.js';

// Liveness flag hung off each socket by the heartbeat below.
type AliveSocket = WebSocket & { isAlive?: boolean };

// A client that floods while the SSH handshake is still in flight would grow
// pendingInput without limit, so cap what we're willing to hold for it.
const MAX_PENDING_BYTES = 256 * 1024;

function pickProtocol(protocols: Set<string>): string | false {
  for (const p of protocols) {
    if (p.startsWith('virtpilot.token.')) return p;
  }
  return false;
}

async function resolveVmIp(vmUuid: string): Promise<string | null> {
  try {
    const meta = await vmMetaService.getVmMeta(vmUuid);
    if (meta?.networks) {
      const primary = meta.networks.find((n) => n.isPrimary);
      if (primary?.ip) return primary.ip;
    }
  } catch { /* ignore */ }

  try {
    const out = await virsh(['domifaddr', vmUuid, '--source', 'arp']);
    const match = out.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/\d+/);
    if (match) return match[1];
  } catch { /* VM not running or no ARP entry yet */ }

  return null;
}

export async function findHostPrivateKey(): Promise<Buffer | null> {
  const keyPath = await ensureHostSshKeypair();
  if (keyPath) {
    try { return await fs.readFile(keyPath); } catch { /* fall through */ }
  }
  return null;
}

export function createSshWss(): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
    handleProtocols: pickProtocol,
  });

  // ws disables the socket timeout, so a client that disappears without a FIN
  // (laptop lid, dropped Wi-Fi, NAT timeout) would hold its SSH channel into
  // the guest open forever. Ping every 30s and drop anyone who misses a pong.
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

    const send = (msg: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    };

    // The socket is open and parsing frames the moment the prelude below
    // yields, so teardown has to be wired up before the first await: a
    // malformed frame emitting 'error' with no listener would take the whole
    // process down (killing every other live session), and a client that
    // vanishes mid-prelude would never fire 'close', leaking the ssh2 client
    // plus a live shell inside the guest.
    let closed = false;
    let ssh: SshClient | null = null;
    let activeStream: ClientChannel | null = null;
    const teardown = (): void => {
      closed = true;
      activeStream?.close();
      ssh?.end();
    };
    ws.on('close', teardown);
    ws.on('error', teardown);

    const meta = await vmMetaService.getVmMeta(vmUuid).catch(() => null);
    const displayName = meta?.name ?? vmUuid;

    send(`\r\n\x1b[2mResolving IP for ${displayName}…\x1b[0m\r\n`);

    const ip = await resolveVmIp(vmUuid);
    if (!ip) {
      send(`\r\n\x1b[31mCould not determine an IP address for "${displayName}".\x1b[0m\r\n`);
      send(`\x1b[2mEnsure the VM is running and has been assigned an IP.\x1b[0m\r\n`);
      ws.close(1011, 'No IP');
      return;
    }

    const username = meta?.username ?? 'root';

    const privateKey = await findHostPrivateKey();

    if (!privateKey && !meta?.password) {
      send(`\r\n\x1b[31mNo SSH credentials available — no private key found and no password in metadata.\x1b[0m\r\n`);
      ws.close(1011, 'No SSH credentials');
      return;
    }

    send(`\x1b[2mConnecting SSH to ${username}@${ip}…\x1b[0m\r\n`);

    const client = new SshClient();
    ssh = client;

    // Attach the inbound handler immediately — not inside ssh.shell — so the
    // client's initial resize message (sent on WS open, before the SSH
    // handshake completes) isn't dropped on the floor. The pty would
    // otherwise boot at the placeholder 220×50 and apps like nano/vi would
    // render at that geometry, leaving a visible right-side gap.
    let latestSize: { cols: number; rows: number } | null = null;
    let pendingInput: Array<{ data: Buffer; isBinary: boolean }> = [];
    let pendingBytes = 0;

    const handleControl = (str: string): boolean => {
      try {
        const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
        if (msg.type === 'resize' && msg.cols && msg.rows) {
          latestSize = { cols: msg.cols, rows: msg.rows };
          if (activeStream) activeStream.setWindow(msg.rows, msg.cols, 0, 0);
          return true;
        }
        if (msg.type === 'ping') return true;
      } catch { /* not JSON */ }
      return false;
    };

    const queueInput = (data: Buffer, isBinary: boolean): void => {
      pendingInput.push({ data, isBinary });
      pendingBytes += data.length;
      if (pendingBytes > MAX_PENDING_BYTES) ws.close(1009, 'Input buffer exceeded');
    };

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const str = (data as Buffer).toString();
        if (handleControl(str)) return;
        if (activeStream) { activeStream.write(str); return; }
        queueInput(Buffer.from(str), false);
        return;
      }
      if (activeStream) { activeStream.write(data as Buffer); return; }
      queueInput(data as Buffer, true);
    });

    client.on('ready', () => {
      // Open the shell at the size the client actually wants (if it's already
      // told us), so the pty is born with the right geometry.
      const initial = latestSize ?? { cols: 220, rows: 50 };
      client.shell({ term: 'xterm-256color', cols: initial.cols, rows: initial.rows }, (err, stream) => {
        if (err) {
          send(`\r\n\x1b[31mSSH shell error: ${err.message}\x1b[0m\r\n`);
          client.end();
          ws.close(1011, 'SSH shell error');
          return;
        }

        activeStream = stream;

        // Send pty output as binary frames — skips UTF-8 round-trip on both
        // sides; xterm.js writes the raw bytes via the Canvas renderer.
        stream.on('data', (data: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
        });

        stream.stderr.on('data', (data: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
        });

        stream.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'SSH session closed');
          client.end();
        });

        // Drain keystrokes the user typed during the SSH handshake.
        for (const { data, isBinary } of pendingInput) {
          stream.write(isBinary ? data : data.toString());
        }
        pendingInput = [];
        pendingBytes = 0;
      });
    });

    client.on('error', (err) => {
      send(`\r\n\x1b[31mSSH error: ${err.message}\x1b[0m\r\n`);
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'SSH error');
    });

    // The client may have gone away while we were resolving the IP and key —
    // don't open a shell inside the guest that nobody is attached to.
    if (closed || ws.readyState !== WebSocket.OPEN) return;

    client.connect({
      host: ip,
      port: 22,
      username,
      ...(privateKey ? { privateKey } : {}),
      ...(meta?.password ? { password: meta.password } : {}),
      // Try publickey first, fall back to password if key auth is rejected
      authHandler: privateKey && meta?.password
        ? ['publickey', 'password']
        : privateKey ? ['publickey'] : ['password'],
      readyTimeout: 15_000,
    });
  });

  return wss;
}
