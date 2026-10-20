import { WebSocketServer, WebSocket } from 'ws';
import { Client as SshClient, type ClientChannel } from 'ssh2';
import fs from 'fs/promises';
import * as vmMetaService from './services/vmMetaService.js';
import { ensureHostSshKeypair } from './services/cloudInitService.js';
import { virsh } from './services/safeExec.js';
import { validateVmUuid } from './lib/validate.js';
import { CLOSE_VM_DOWN } from './lib/serialConsole.js';

// Liveness flag hung off each socket by the heartbeat below.
type AliveSocket = WebSocket & { isAlive?: boolean };

// A client that floods while the SSH handshake is still in flight would grow
// pendingInput without limit, so cap what we're willing to hold for it.
const MAX_PENDING_BYTES = 256 * 1024;

// How long a session waits for a guest that is running but has no address yet
// (one that has only just been powered on).
const IP_WAIT_MS = 90_000;

// WebSocket close reasons are capped at 123 bytes (ws throws beyond that).
function closeReason(text: string): string {
  let out = text;
  while (Buffer.byteLength(out) > 120) out = out.slice(0, -1);
  return out;
}

/** The domain's state as virsh words it ("running", "paused", "shut off"); null if unknown. */
async function domState(vmUuid: string): Promise<string | null> {
  try {
    return (await virsh(['domstate', vmUuid])).trim();
  } catch {
    return null;
  }
}

const isRunning = async (vmUuid: string) => (await domState(vmUuid)) === 'running';

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
    // Control frames (ready, pong) go only to a browser that asked for them: a console
    // window still running an older page would print them as text.
    const control = url.searchParams.get('ctl') === '1';
    const sendControl = (msg: object) => { if (control) send(JSON.stringify(msg)); };

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

    // The inbound handler goes on before the first await too. The browser sends
    // its terminal size the moment the socket opens, while the IP and key are
    // still being looked up; a frame with no listener is lost, and the shell
    // would then open at the placeholder 220×50 (nano and vi drawn too wide).
    // It also answers pings while a booting guest is waited for.
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
        // The answer lets the browser tell a live socket from a half-open one (a
        // laptop asleep, a dropped VPN), where sends succeed and nothing arrives.
        if (msg.type === 'ping') { sendControl({ type: 'pong' }); return true; }
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

    const meta = await vmMetaService.getVmMeta(vmUuid).catch(() => null);
    const displayName = meta?.name ?? vmUuid;

    send(`\r\n\x1b[90mResolving IP for ${displayName}…\x1b[0m\r\n`);

    // A VM that is off closes with its own code, so the browser offers Power on; a
    // paused one can't answer SSH until it is resumed.
    const state = await domState(vmUuid);
    if (state !== 'running') {
      if (closed) return;
      if (state === 'paused') ws.close(1011, 'The VM is paused');
      else ws.close(CLOSE_VM_DOWN, 'The VM is not running');
      return;
    }

    const startedAt = Date.now();
    let ip = await resolveVmIp(vmUuid);
    if (!ip && !closed) {
      // A guest that has only just started has no address yet. Wait for one (DHCP on
      // a fresh boot takes seconds to a minute) for as long as the browser is there.
      send(`\x1b[90mWaiting for ${displayName} to report an IP address…\x1b[0m\r\n`);
      while (!ip && !closed && Date.now() - startedAt < IP_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (closed || !(await isRunning(vmUuid))) break;
        ip = await resolveVmIp(vmUuid);
      }
    }
    if (closed) return;
    if (!ip) {
      // Stopped while we waited: the VM is off, not addressless.
      if (!(await isRunning(vmUuid))) {
        if (!closed) ws.close(CLOSE_VM_DOWN, 'The VM is not running');
        return;
      }
      send(`\r\n\x1b[31mCould not determine an IP address for "${displayName}".\x1b[0m\r\n`);
      send(`\x1b[90mEnsure the VM is running and has been assigned an IP.\x1b[0m\r\n`);
      ws.close(1011, 'No IP address found');
      return;
    }

    const username = meta?.username ?? 'root';

    const privateKey = await findHostPrivateKey();

    if (!privateKey && !meta?.password) {
      send(`\r\n\x1b[31mNo SSH credentials available - no private key found and no password in metadata.\x1b[0m\r\n`);
      ws.close(1011, 'No SSH key or password for this VM');
      return;
    }

    send(`\x1b[90mConnecting SSH to ${username}@${ip}…\x1b[0m\r\n`);

    let waitingForSshd = false;
    const connectTo = (host: string): void => {
      const client = new SshClient();
      ssh = client;

      client.on('ready', () => {
        // Open the shell at the size the client actually wants (if it's already
        // told us), so the pty is born with the right geometry.
        const initial = latestSize ?? { cols: 220, rows: 50 };
        client.shell({ term: 'xterm-256color', cols: initial.cols, rows: initial.rows }, (err, stream) => {
          if (err) {
            send(`\r\n\x1b[31mSSH shell error: ${err.message}\x1b[0m\r\n`);
            client.end();
            ws.close(1011, closeReason(`SSH shell error: ${err.message}`));
            return;
          }

          activeStream = stream;
          // The session is live from here (until now the socket was only waiting on
          // the guest): the browser shows it as connected.
          sendControl({ type: 'ready' });

          // Send pty output as binary frames — skips UTF-8 round-trip on both
          // sides; xterm.js writes the raw bytes via the Canvas renderer.
          stream.on('data', (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
          });

          stream.stderr.on('data', (data: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
          });

          // The shell exited (logout, exit): a clean end with nothing more to say.
          stream.on('close', () => {
            if (ws.readyState === WebSocket.OPEN) ws.close(1000);
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

      client.on('error', (err: Error & { level?: string }) => {
        if (closed || ssh !== client) return;
        // A guest that is still booting refuses or ignores the connection until sshd is
        // up (its address may even be one it held before it stopped). Keep trying for as
        // long as the address wait would have, while the VM runs; a rejected login or a
        // protocol error ends the session at once.
        const transient = err.level === 'client-socket' || err.level === 'client-timeout';
        if (transient && !activeStream && Date.now() - startedAt < IP_WAIT_MS) {
          void (async () => {
            if (!(await isRunning(vmUuid))) {
              if (!closed) ws.close(CLOSE_VM_DOWN, 'The VM is not running');
              return;
            }
            if (!waitingForSshd) {
              waitingForSshd = true;
              send(`\x1b[90mWaiting for SSH on ${host}:22…\x1b[0m\r\n`);
            }
            client.end();
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (closed || ssh !== client) return;
            connectTo((await resolveVmIp(vmUuid)) ?? host);
          })();
          return;
        }
        send(`\r\n\x1b[31mSSH error: ${err.message}\x1b[0m\r\n`);
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, closeReason(`SSH error: ${err.message}`));
      });

      client.connect({
        host,
        port: 22,
        username,
        ...(privateKey ? { privateKey } : {}),
        ...(meta?.password ? { password: meta.password } : {}),
        // Try publickey first, fall back to password if key auth is rejected
        authHandler: privateKey && meta?.password
          ? ['publickey', 'password']
          : privateKey ? ['publickey'] : ['password'],
        readyTimeout: 15_000,
        // A guest that is forced off never says goodbye: without keepalives its
        // session would look alive until TCP gave up, many minutes later.
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
      });
    };

    // The client may have gone away while we were resolving the IP and key —
    // don't open a shell inside the guest that nobody is attached to.
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    connectTo(ip);
  });

  return wss;
}
