import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import { config } from './config.js';
import { validateVmUuid } from './lib/validate.js';
import { Backlog, CLOSE_VM_DOWN, consoleExit, createBannerFilter, stripInput, type BannerFilter } from './lib/serialConsole.js';

// Liveness flag hung off each socket by the heartbeat below.
type AliveSocket = WebSocket & { isAlive?: boolean };

// A guest's serial port takes one reader: a second `virsh console --force` knocks the
// first off ("stream had I/O failure"), so two tabs or windows on the same VM used to
// end each other's sessions. Every socket for a VM now shares one `virsh console`: its
// output goes to all of them, input comes from any, and whoever joins late is shown the
// recent output first.
const BACKLOG_BYTES = 128 * 1024;
// A session nobody watches stays attached this long, so a reconnect after a network
// blip (or a reload) picks it up again with nothing lost.
const LINGER_MS = 10_000;
// virsh prints its banner at once; output held back in case it was the banner is let
// go after this long whatever it was.
const BANNER_WAIT_MS = 1500;

interface ConsoleHub {
  vmUuid: string;
  /** Names this `virsh console` process: offsets mean nothing across two of them. */
  epoch: string;
  proc: pty.IPty;
  clients: Set<AliveSocket>;
  backlog: Backlog;
  banner: BannerFilter;
  /** The last of the raw output, for the words on why the console ended. */
  tail: string;
  linger: NodeJS.Timeout | null;
  ended: boolean;
}

const hubs = new Map<string, ConsoleHub>();

// Pick the token-bearing subprotocol so the ws library echoes it back in the
// 101 Switching Protocols response. Without this the browser tears the
// connection down with "subprotocol not accepted".
function pickProtocol(protocols: Set<string>): string | false {
  for (const p of protocols) {
    if (p.startsWith('virtpilot.token.')) return p;
  }
  return false;
}

// node-pty's default `kill()` sends SIGHUP, which `virsh console` ignores
// when blocked in a libvirt RPC — leaving stale `virsh` children attached
// to the VM's serial PTY. Send SIGTERM first, then escalate to SIGKILL after
// a short grace period if it's still alive.
function reapPty(proc: pty.IPty): void {
  const pid = proc.pid;
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(pid, 0); } catch { return; }
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }, 1500).unref();
}

function broadcast(hub: ConsoleHub, text: string): void {
  if (!text) return;
  const buf = Buffer.from(text, 'utf8');
  hub.backlog.append(buf);
  for (const ws of hub.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true });
  }
}

function endHub(hub: ConsoleHub): void {
  hub.ended = true;
  if (hub.linger) { clearTimeout(hub.linger); hub.linger = null; }
  if (hubs.get(hub.vmUuid) === hub) hubs.delete(hub.vmUuid);
}

// Throws when virsh can't be started at all.
function openHub(vmUuid: string): ConsoleHub {
  const proc = pty.spawn('virsh', ['-c', config.libvirtUri, 'console', vmUuid, '--force'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 50,
    cwd: process.env.HOME ?? '/',
    env: process.env as Record<string, string>,
  });
  const hub: ConsoleHub = {
    vmUuid,
    epoch: crypto.randomBytes(6).toString('hex'),
    proc,
    clients: new Set(),
    backlog: new Backlog(BACKLOG_BYTES),
    banner: createBannerFilter(),
    tail: '',
    linger: null,
    ended: false,
  };
  hubs.set(vmUuid, hub);

  const bannerTimer = setTimeout(() => broadcast(hub, hub.banner.flush()), BANNER_WAIT_MS);
  bannerTimer.unref();

  proc.onData((data: string) => {
    hub.tail = (hub.tail + data).slice(-2048);
    broadcast(hub, hub.banner.push(data));
  });

  proc.onExit(({ exitCode }) => {
    clearTimeout(bannerTimer);
    broadcast(hub, hub.banner.flush());
    endHub(hub);
    // A VM that is down closes with its own code, so the browser offers Power on.
    const { reason, vmDown } = consoleExit(exitCode, hub.tail);
    for (const ws of hub.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close(vmDown ? CLOSE_VM_DOWN : 1000, reason);
    }
    hub.clients.clear();
  });

  return hub;
}

function leave(hub: ConsoleHub, ws: AliveSocket): void {
  if (!hub.clients.delete(ws) || hub.ended || hub.clients.size > 0) return;
  hub.linger = setTimeout(() => {
    if (hub.clients.size > 0 || hub.ended) return;
    endHub(hub);
    reapPty(hub.proc);
  }, LINGER_MS);
  hub.linger.unref();
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

  // ws disables the socket timeout, so a client that disappears without a FIN
  // (laptop lid, dropped Wi-Fi, NAT timeout) would keep its place on the console
  // forever. Ping every 30s and drop anyone who misses a pong.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const client = socket as AliveSocket;
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => {
    clearInterval(heartbeat);
    for (const hub of [...hubs.values()]) {
      endHub(hub);
      reapPty(hub.proc);
    }
  });

  wss.on('connection', (socket, req) => {
    const ws = socket as AliveSocket;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const url = new URL(req.url ?? '', 'http://localhost');
    let vmUuid: string;
    try {
      vmUuid = validateVmUuid(url.searchParams.get('vm'));
    } catch {
      ws.close(1008, 'Invalid vm parameter');
      return;
    }

    let hub = hubs.get(vmUuid);
    try {
      if (!hub || hub.ended) hub = openHub(vmUuid);
    } catch (err) {
      ws.send(`\r\nFailed to open console: ${String(err)}\r\n`);
      ws.close(1011, 'Console spawn error');
      return;
    }
    const session = hub;
    if (session.linger) { clearTimeout(session.linger); session.linger = null; }
    session.clients.add(ws);

    // A viewer coming back to the same session (same epoch) is sent exactly what it
    // missed, when the backlog still reaches back that far; anyone else gets the
    // backlog from its first whole line. The attach frame says which, and the offset
    // the replay starts at, so the viewer can keep counting.
    const since = Number(url.searchParams.get('since'));
    const missed = url.searchParams.get('epoch') === session.epoch && url.searchParams.has('since')
      ? session.backlog.since(since)
      : null;
    const replay = missed !== null ? { from: since, data: missed } : session.backlog.replay();
    // Control frames (attach, pong) go only to a browser that asked for them: a console
    // window still running an older page would print them as text.
    const control = url.searchParams.get('ctl') === '1';
    if (control) ws.send(JSON.stringify({
      type: 'attach',
      epoch: session.epoch,
      offset: replay.from,
      bytes: replay.data.length,
      resumed: missed !== null,
    }));
    if (replay.data.length > 0) ws.send(replay.data, { binary: true });

    // Text frames carry JSON control messages (resize, ping); binary frames
    // carry raw keystrokes. Distinguishing prevents a pasted JSON-looking
    // string from accidentally triggering a pty resize.
    ws.on('message', (data, isBinary) => {
      if (session.ended) return;
      if (!isBinary) {
        const str = (data as Buffer).toString();
        try {
          const msg = JSON.parse(str) as { type?: string; cols?: number; rows?: number };
          if (msg.type === 'resize') {
            // A serial line has no window size the guest can see; the pty's is kept in
            // step anyway, from whichever viewer resized last.
            if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols! > 0 && msg.rows! > 0) {
              try { session.proc.resize(Math.min(msg.cols!, 1000), Math.min(msg.rows!, 500)); } catch { /* exited */ }
            }
            return;
          }
          if (msg.type === 'ping') {
            if (control) ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
        } catch { /* fall through and treat as input */ }
        session.proc.write(stripInput(Buffer.from(str)).toString());
        return;
      }
      session.proc.write(stripInput(data as Buffer).toString());
    });

    ws.on('close', () => leave(session, ws));
    ws.on('error', () => leave(session, ws));
  });

  return wss;
}
