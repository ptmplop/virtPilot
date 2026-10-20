import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { THEMES, type ThemeId } from '@/lib/terminalThemes';
import { cn } from '@/lib/cn';
import { SessionBar, type SessionEnd } from './SessionBar';
import {
  CLOSE_VM_DOWN,
  IS_MAC,
  MAX_RECONNECT_ATTEMPTS,
  endReason,
  isFinalClose,
  matchShortcut,
  reconnectDelay,
  wsProtocols,
  wsUrl,
  type ConnState,
  type PaneAction,
} from './session';

// The terminal is set in JetBrains Mono, the app's face for identifiers. Fixed-width
// system faces stand behind it for the glyphs it doesn't carry (arrows, shapes, CJK), so
// a fallback glyph still lands on the cell grid; box drawing and block elements are drawn
// by the canvas renderer itself.
const TERMINAL_FONT = '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const SYSTEM_MONO_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const FONT_PROBE = '400 13px "JetBrains Mono Variable"';

function fontLoaded(): boolean {
  try {
    return document.fonts.check(FONT_PROBE);
  } catch {
    return true;
  }
}

// Settles once the terminal face can paint: at once when it already can, after 3s at most.
function fontReady(): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return Promise.resolve();
  const loaded = fonts
    .load(FONT_PROBE, 'W─')
    .then(() => fonts.ready)
    .then(() => undefined, () => undefined);
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, 3000));
  return Promise.race([loaded, timeout]);
}

// The element xterm opens into. The terminal's margin is padding on xterm's own .xterm
// element: xterm paints its ground under it and draws the cells inside it, and the fit
// below takes it off before counting cells.
const TERMINAL_HOST = 'vp-terminal-host min-w-0 flex-1 overflow-hidden [&_.xterm]:px-4 [&_.xterm]:pt-2';

interface TerminalPaneProps {
  vmId: string;
  kind: 'console' | 'ssh';
  themeId: ThemeId;
  /** The VM can take a session (running or paused); false while it is off; null until known. */
  reachable: boolean | null;
  /** Why it can't, in words ("web-01 is stopped"), and the way out. */
  stopped: { message: string; onPowerOn?: () => void; pending?: boolean } | null;
  /** The same, for when the backend found the VM off before the polled list did. */
  down: { message: string; onPowerOn?: () => void; pending?: boolean };
  /** When the VM list now shown was asked for (ms). A reading asked for before a session
      ended says nothing about the VM since. */
  listAsOf: number;
  /** Bumped when the VM was just powered on from this window: dial again at once. */
  wakeKey: number;
  /** The pane has the cursor: its tab is showing and it is the tab's focused pane. */
  active: boolean;
  /** The pane shares its tab with others. */
  split: boolean;
  /** Bumped when the workspace wants the cursor back in the active pane. */
  focusKey: number;
  onConnState: (state: ConnState) => void;
  onAction: (action: Exclude<PaneAction, 'clear'>) => void;
  onTitle: (title: string) => void;
  onOutput: () => void;
}

/**
 * One terminal session (the serial console or SSH) in a pane. The terminal outlives its
 * socket: a network blip redials with backoff and the scrollback survives; a session that
 * ends keeps its output under a bar offering Reconnect (or Power on, once the VM is off).
 */
export function TerminalPane(props: TerminalPaneProps) {
  const { kind, themeId, reachable, stopped, down, listAsOf, wakeKey, active, split, focusKey } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const barButtonRef = useRef<HTMLButtonElement>(null);
  const [ended, setEnded] = useState<SessionEnd | null>(null);
  // Dialled at least once: until then a VM that is off shows its own bar, not "ended".
  const [dialled, setDialled] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const endedRef = useRef(ended);
  endedRef.current = ended;
  const dialRef = useRef<() => void>(() => {});
  // When the session last ended, and when the VM was last known to be off after that
  // (0: not known). A session dials again by itself only once the VM is seen running in
  // a list asked for after it was off.
  const endedAtRef = useRef(0);
  const downAtRef = useRef(0);
  const connectedAtRef = useRef(0);
  const hangUpRef = useRef<() => void>(() => {});
  const searchRef = useRef<SearchAddon | null>(null);
  // Callbacks change every render; the terminal's handlers, set up once, read them here.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    let aborted = false;

    const fontWasReady = fontLoaded();
    const term = new XTerm({
      theme: { ...THEMES[latest.current.themeId].palette },
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      lineHeight: 1.15,
      letterSpacing: 0,
      fontWeightBold: 600,
      cursorBlink: true,
      cursorStyle: 'bar',
      // Text the theme draws too faint (a dim note, a theme's grey comments) is lifted to
      // 4.5:1 against its ground, as VS Code's terminal does by default.
      minimumContrastRatio: 4.5,
      // No convertEol: the guest's tty already turns "\n" into "\r\n" for ordinary
      // output, and programs in raw mode (tmux, screen, curses) send a bare LF to mean
      // "down one row, same column"; converting it drew their screens in the wrong cells.
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    const search = new SearchAddon();
    searchRef.current = search;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(search);
    term.open(host);

    // Fit by measuring, not with FitAddon: it always reserves a scrollbar's width when
    // there is scrollback, so nano, vi and htop drew their screens two columns short of
    // the terminal. floor(), not ceil(): the column count is what the pty is told, and a
    // column the pane clips is one the program paints into unseen. The sub-cell sliver
    // floor() leaves is the theme's ground, so it never shows.
    const fitNow = () => {
      const el = containerRef.current;
      if (!el) return;
      // A pane in a hidden tab measures 0×0: fitting then would squeeze the pty to two
      // columns and reflow the remote screen. The observer fires again once it shows.
      if (!el.clientWidth || !el.clientHeight) return;
      // _core / _renderService are private but stable since xterm 5; FitAddon reads them too.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cell = (term as any)._core?._renderService?.dimensions?.css?.cell as
        | { width: number; height: number }
        | undefined;
      if (!cell?.width || !cell?.height) {
        try { fit.fit(); } catch { /* detached */ }
        return;
      }
      const pad = term.element ? window.getComputedStyle(term.element) : null;
      const padX = pad ? parseFloat(pad.paddingLeft) + parseFloat(pad.paddingRight) : 0;
      const padY = pad ? parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom) : 0;
      const cols = Math.max(2, Math.floor((el.clientWidth - padX) / cell.width));
      const rows = Math.max(1, Math.floor((el.clientHeight - padY) / cell.height));
      if (term.cols !== cols || term.rows !== rows) {
        try { term.resize(cols, rows); } catch { /* detached */ }
      }
    };

    // The observer catches font loads, split drags and tab switches as well as window
    // resizes. The frame coalesces a drag; the trailing timer makes sure the last size
    // of a drag is the one the pty is told.
    let rafId = 0;
    let settleTimer = 0;
    const scheduleFit = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(fitNow);
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(fitNow, 150);
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);

    // The canvas renderer is far faster than the DOM one and, unlike WebGL, copes with a
    // fallback glyph; loaded once the face is in, so its glyph atlas uses the final font.
    let canvas: CanvasAddon | null = null;
    // A devicePixelRatio change (browser zoom, a monitor with another scale) leaves the
    // box the same size, so no resize fires, but the atlas is now drawn at the wrong
    // scale and the cell size has drifted: drop the atlas and fit again.
    let dprCleanup: (() => void) | null = null;
    const watchDpr = () => {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onDpr = () => {
        try { canvas?.clearTextureAtlas(); } catch { /* DOM renderer */ }
        scheduleFit();
        watchDpr();
      };
      mq.addEventListener('change', onDpr, { once: true });
      dprCleanup = () => mq.removeEventListener('change', onDpr);
    };
    void fontReady().then(() => {
      if (aborted) return;
      // xterm measured its cell when it opened; if the face has only arrived since, that
      // was the fallback's. Stepping fontFamily off and back makes it measure again.
      if (!fontWasReady) {
        term.options.fontFamily = SYSTEM_MONO_FONT;
        term.options.fontFamily = TERMINAL_FONT;
      }
      try { canvas = new CanvasAddon(); term.loadAddon(canvas); } catch { /* DOM renderer */ }
      scheduleFit();
      watchDpr();
    });

    // Copy, paste and find are Ctrl+Shift+C/V/F, clear of the shell's own Ctrl+C and
    // Ctrl+V; the tab and split shortcuts are caught here too, since keys land on xterm's
    // textarea while the terminal has focus. Returning false stops xterm only; a browser
    // default has to be prevented as well.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // A live terminal keeps Tab for the shell. Once the session has ended, let the
      // browser move focus on, to the bar's button.
      if (e.key === 'Tab' && endedRef.current) return false;
      const action = matchShortcut(e);
      if (action) {
        e.preventDefault();
        if (action === 'clear') term.clear();
        else latest.current.onAction(action);
        return false;
      }
      if (!e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyV') {
        // Windows and Linux browsers paste on Ctrl+Shift+V themselves; reading the
        // clipboard as well pasted everything twice. macOS has no such default.
        if (IS_MAC) {
          e.preventDefault();
          navigator.clipboard.readText().then((t) => term.paste(t)).catch(() => {});
        }
        return false;
      }
      if (e.code === 'KeyC') {
        // Ctrl+Shift+C is also the browsers' inspect-element key: claimed even with
        // nothing selected, so it never opens DevTools over the terminal.
        e.preventDefault();
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (e.code === 'KeyF') {
        e.preventDefault();
        setFindOpen(true);
        return false;
      }
      return true;
    });

    // The connection. The terminal stays across reconnects, so the scrollback survives.
    let ws: WebSocket | null = null;
    let attempts = 0;
    let wasConnected = false;
    let reconnectTimer = 0;
    let pingTimer = 0;
    let stableTimer = 0;
    // When the ping now waiting for an answer went out (0: none). Its age, not the time
    // since the last answer, decides: a hidden window's timers can run a minute apart,
    // which must not read as a dead socket.
    let pingSentAt = 0;
    // The serial console is shared: it says which session this is and where its replay
    // starts, so a reconnect can ask for just what it missed.
    let epoch: string | null = null;
    let offset = 0;
    let noteAfterReplay = false;
    const encoder = new TextEncoder();

    const setState = (s: ConnState) => latest.current.onConnState(s);
    const stopKeepalive = () => {
      if (pingTimer) { window.clearInterval(pingTimer); pingTimer = 0; }
    };
    // The console's own notes are bright black, not dim: xterm halves the contrast it
    // demands for dim text, so a dim note can't be lifted to a readable grey.
    const note = (text: string) => term.writeln(`\x1b[90m${text}\x1b[0m`);

    const becameConnected = () => {
      wasConnected = true;
      connectedAtRef.current = Date.now();
      setState('connected');
      // A flapping endpoint (accept, then drop) would otherwise come back in at the
      // 250ms floor every time: the backoff only resets once a session has held.
      if (stableTimer) window.clearTimeout(stableTimer);
      stableTimer = window.setTimeout(() => { attempts = 0; }, 12_000);
    };

    const handleClose = (sock: WebSocket, code: number, reason: string) => {
      stopKeepalive();
      if (stableTimer) { window.clearTimeout(stableTimer); stableTimer = 0; }
      if (ws === sock) ws = null;
      if (aborted) return;
      if (isFinalClose(code) || !wasConnected) {
        const vmDown = code === CLOSE_VM_DOWN;
        const failed = !vmDown && (code === 1011 || !wasConnected);
        // A VM that went off is not a fault: the header says "Not connected", quietly.
        setState(vmDown ? 'idle' : failed ? 'error' : 'closed');
        const detail = endReason(code, reason, wasConnected);
        note(`\r\n[${wasConnected ? 'Session ended' : 'Couldn’t connect'}${detail ? `: ${detail}` : ''}]`);
        endedAtRef.current = Date.now();
        downAtRef.current = vmDown ? endedAtRef.current : 0;
        setEnded({ title: wasConnected ? 'Session ended' : 'Couldn’t connect', reason: detail, failed, vmDown });
        return;
      }
      if (attempts >= MAX_RECONNECT_ATTEMPTS) {
        setState('error');
        note('\r\n[Reconnection failed]');
        endedAtRef.current = Date.now();
        downAtRef.current = 0;
        setEnded({ title: 'Reconnection failed', reason: null, failed: true });
        return;
      }
      const delay = reconnectDelay(attempts);
      setState('reconnecting');
      note(`\r\n[Reconnecting in ${(delay / 1000).toFixed(1)}s…]`);
      reconnectTimer = window.setTimeout(connect, delay);
    };

    // Drops a socket without waiting for its closing handshake; its late events can't
    // touch whatever replaces it.
    const abandon = (sock: WebSocket, code: number, reason: string) => {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      handleClose(sock, code, reason);
      try { sock.close(); } catch { /* already closed */ }
    };

    const startKeepalive = () => {
      stopKeepalive();
      pingTimer = window.setInterval(() => {
        const sock = ws;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        // A ping unanswered for 15s: the socket is half-open (a laptop asleep, a
        // dropped VPN), where sends succeed and nothing arrives. close() would wait for
        // a handshake that can't finish, so abandon it and take the reconnect path now.
        if (pingSentAt && Date.now() - pingSentAt > 15_000) {
          abandon(sock, 1006, '');
          return;
        }
        if (!pingSentAt) {
          pingSentAt = Date.now();
          sock.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
    };

    const connect = () => {
      if (aborted) return;
      attempts += 1;
      setState(wasConnected ? 'reconnecting' : 'connecting');
      // ctl=1: this page understands the backend's JSON control frames (attach, ready, pong).
      const params: Record<string, string> = { vm: latest.current.vmId, ctl: '1' };
      if (kind === 'console' && epoch) {
        params.epoch = epoch;
        params.since = String(offset);
      }
      const sock = new WebSocket(wsUrl(kind === 'console' ? '/ws/console' : '/ws/ssh', params), wsProtocols());
      sock.binaryType = 'arraybuffer';
      ws = sock;

      sock.onopen = () => {
        pingSentAt = 0;
        startKeepalive();
        // Measure again before telling the pty its size, so it is born at the live size.
        fitNow();
        sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      sock.onmessage = (e) => {
        if (typeof e.data === 'string') {
          // Control frames are JSON; the backend's own status text starts with \r\n or ESC.
          if (e.data.charCodeAt(0) === 0x7b) {
            try {
              const msg = JSON.parse(e.data) as { type?: string; epoch?: string; offset?: number; resumed?: boolean; bytes?: number };
              if (msg.type === 'pong') { pingSentAt = 0; return; }
              pingSentAt = 0;
              if (msg.type === 'ready') { becameConnected(); return; }
              if (msg.type === 'attach') {
                const resumed = !!msg.resumed;
                epoch = msg.epoch ?? null;
                offset = msg.offset ?? 0;
                becameConnected();
                // Said once the replay is in, so it reads after the console's recent output.
                if (!resumed) {
                  if (msg.bytes) noteAfterReplay = true;
                  else note('[Serial console attached. Press Enter for a prompt.]');
                }
                return;
              }
            } catch { /* not a control frame: show it */ }
          }
          term.write(e.data);
        } else {
          const bytes = new Uint8Array(e.data as ArrayBuffer);
          offset += bytes.length;
          term.write(bytes);
          if (noteAfterReplay) {
            noteAfterReplay = false;
            note('\r\n[Serial console attached. Press Enter for a prompt.]');
          }
        }
        // Anything arriving proves the socket alive.
        pingSentAt = 0;
        latest.current.onOutput();
      };

      sock.onclose = (e) => handleClose(sock, e.code, e.reason);
      sock.onerror = () => { /* onclose follows and decides */ };
    };

    // Keystrokes go out as binary frames, so a pasted '{"type":"resize"…}' is typed, not
    // obeyed; control messages stay text.
    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    term.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
    term.onTitleChange((title) => latest.current.onTitle(title));

    // The VM list says the VM went off while this session still looks alive: an SSH
    // connection to a guest that was forced off never hears a goodbye, and would read
    // Connected until TCP gave up. End it here, as the VM being off.
    hangUpRef.current = () => {
      if (aborted || !ws) return;
      abandon(ws, CLOSE_VM_DOWN, 'The VM stopped');
    };

    dialRef.current = () => {
      if (aborted || ws) return;
      if (reconnectTimer) { window.clearTimeout(reconnectTimer); reconnectTimer = 0; }
      attempts = 0;
      setEnded(null);
      setDialled(true);
      connect();
    };

    // Fit before the first dial, so the opening resize carries the real geometry rather
    // than xterm's 80×24 (nano opened at once would leave a strip unpainted).
    fitNow();

    return () => {
      aborted = true;
      stopKeepalive();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (stableTimer) window.clearTimeout(stableTimer);
      if (settleTimer) window.clearTimeout(settleTimer);
      if (rafId) cancelAnimationFrame(rafId);
      dprCleanup?.();
      ro.disconnect();
      ws?.close(1000, 'unmount');
      // One task later: open() queued a timer that reads the renderer, and a pane closed
      // straight after opening (or React's development double mount) would throw on it.
      window.setTimeout(() => term.dispose(), 0);
      termRef.current = null;
      searchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Waiting for a VM that is off: nothing is connecting, so the header says so.
  useEffect(() => {
    if (reachable === false && !dialled) latest.current.onConnState('idle');
  }, [reachable, dialled]);

  // Dial once the VM can take a session: at once if it already can, else when it starts.
  // A session that ended because the VM went off dials again by itself when the VM is
  // back, so a serial console shows the boot from its first line (and SSH waits for the
  // guest's address). The list is polled, so only readings asked for after the session
  // ended count: one begun before a stop can still say "running" after it.
  useEffect(() => {
    if (ended && reachable === false && listAsOf > endedAtRef.current) {
      downAtRef.current = Math.max(downAtRef.current, listAsOf);
    }
    // Off in a reading asked for after the session connected: it can't still be live.
    if (!ended && dialled && reachable === false && connectedAtRef.current && listAsOf > connectedAtRef.current) {
      hangUpRef.current();
    }
  }, [reachable, listAsOf, ended, dialled]);
  useEffect(() => {
    if (reachable !== true) return;
    if (!dialled) {
      dialRef.current();
    } else if (endedRef.current && downAtRef.current && listAsOf > downAtRef.current) {
      downAtRef.current = 0;
      dialRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachable, listAsOf]);

  // Powered on from this window: dial now, rather than on the next status poll. Compared
  // with the last value seen, not skipped once: React runs effects twice in development.
  const wakeSeen = useRef(wakeKey);
  useEffect(() => {
    if (wakeKey === wakeSeen.current) return;
    wakeSeen.current = wakeKey;
    if (!dialled || endedRef.current) dialRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeKey]);

  // Theme changes apply live, keeping the scrollback (a fresh object is what repaints).
  const themeFirst = useRef(true);
  useEffect(() => {
    if (themeFirst.current) { themeFirst.current = false; return; }
    if (termRef.current) termRef.current.options.theme = { ...THEMES[themeId].palette };
  }, [themeId]);

  // The active pane takes the cursor when it becomes active and whenever the workspace
  // asks: its terminal, or its bar's button when there is no live session to type into.
  const showBar = !!ended || (reachable === false && !dialled);
  useEffect(() => {
    if (!active || findOpen) return;
    (showBar ? barButtonRef.current : termRef.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusKey]);

  // A session that ends under the cursor hands focus to the bar, so Enter dials again.
  useEffect(() => {
    if (!ended || !latest.current.active) return;
    if (containerRef.current?.contains(document.activeElement)) barButtonRef.current?.focus();
  }, [ended]);

  // The bar says the VM is off when the list says so, or when the backend found it off
  // before the next poll did.
  const offBar = reachable === false ? stopped : ended?.vmDown ? down : null;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div ref={containerRef} className={TERMINAL_HOST} />
      {findOpen && (
        <FindBar
          split={split}
          onFind={(q, back) => {
            const s = searchRef.current;
            if (!s || !q) return true;
            return back ? s.findPrevious(q, { caseSensitive: false }) : s.findNext(q, { caseSensitive: false });
          }}
          onClose={() => {
            setFindOpen(false);
            searchRef.current?.clearDecorations();
            termRef.current?.clearSelection();
            termRef.current?.focus();
          }}
        />
      )}
      {showBar && !findOpen && (
        <SessionBar
          ref={barButtonRef}
          ended={ended}
          stopped={offBar}
          onReconnect={() => {
            dialRef.current();
            termRef.current?.focus();
          }}
          split={split}
        />
      )}
    </div>
  );
}

// Find in the scrollback: a small bar over the pane's top right. Enter finds the next
// match, Shift+Enter the previous one, Escape closes it and puts the cursor back.
function FindBar({
  split,
  onFind,
  onClose,
}: {
  split: boolean;
  onFind: (query: string, back: boolean) => boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [missed, setMissed] = useState(false);
  const find = (back: boolean) => setMissed(!onFind(query, back));
  return (
    <div
      role="search"
      className={cn(
        'absolute top-2 z-30 flex animate-fade-in items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-pop',
        split ? 'right-12' : 'right-3',
      )}
    >
      {/* "No match" sits inside the field, so nothing moves under the caret when it shows. */}
      <div className="relative">
        <input
          autoFocus
          aria-label="Find in the scrollback"
          placeholder="Find"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMissed(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              find(e.shiftKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          className="h-7 w-52 rounded-md border border-input bg-field pl-2 pr-[4.5rem] text-[12.5px] text-foreground outline-none focus:border-ring"
        />
        <span aria-live="polite" className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[12px] text-amber-300">
          {missed ? 'No match' : ''}
        </span>
      </div>
      <FindButton label="Previous match" onClick={() => find(true)}>
        <ArrowUp size={14} />
      </FindButton>
      <FindButton label="Next match" onClick={() => find(false)}>
        <ArrowDown size={14} />
      </FindButton>
      <FindButton label="Close find" onClick={onClose}>
        <X size={14} />
      </FindButton>
    </div>
  );
}

function FindButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}
