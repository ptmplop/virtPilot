import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Check, ChevronDown, Monitor, Palette, Play, Power, RefreshCw, Square, Terminal, Wifi, Zap } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { toast } from 'sonner';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import RFB from '@novnc/novnc/lib/rfb.js';
import { cn } from '@/lib/cn';
import { useVm, useVmAction } from '@/hooks/useVms';
import { loadTerminalTheme, saveTerminalTheme, THEME_ORDER, THEMES, type ThemeId } from '@/lib/terminalThemes';

type ConnState = 'connecting' | 'reconnecting' | 'connected' | 'closed' | 'error';
type Tab = 'console' | 'ssh' | 'vnc';

const connLabel: Record<ConnState, string> = {
  connecting:   'Connecting…',
  reconnecting: 'Reconnecting…',
  connected:    'Connected',
  closed:       'Disconnected',
  error:        'Error',
};

const connDotClass: Record<ConnState, string> = {
  connecting:   'bg-amber-400 animate-pulse',
  reconnecting: 'bg-amber-400 animate-pulse',
  connected:    'bg-emerald-500',
  closed:       'bg-slate-500',
  error:        'bg-red-500',
};

interface TerminalPaneProps {
  name: string;
  tab: 'console' | 'ssh';
  themeId: ThemeId;
  onConnState: (s: ConnState) => void;
}

function TerminalPane({ name, tab, themeId, onConnState }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  // Read the latest themeId from a ref inside the mount effect so a theme
  // change doesn't tear down and re-create the terminal (and lose scrollback).
  // The companion effect below applies subsequent changes via term.options.
  const themeIdRef = useRef(themeId);
  themeIdRef.current = themeId;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: { ...THEMES[themeIdRef.current].palette },
      // System monospace stack (Menlo / Consolas / DejaVu Sans Mono) for full
      // glyph coverage — display fonts like Geist Mono lack some of the
      // unicode arrows / bullets nano and friends paint in status bars and
      // trigger per-glyph font substitution at non-monospace widths.
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Geist Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: true,
      scrollback: 5000,
    });

    termRef.current = term;
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(search);
    term.open(containerRef.current);

    // Compute & apply dimensions, bypassing FitAddon. FitAddon always
    // subtracts a scrollbar reservation (≥15px hard-coded fallback) when
    // scrollback > 0, which makes nano/vi/htop paint their UIs at a smaller
    // width than the terminal actually renders — visible as a gap on the
    // right. We measure clientWidth/Height directly and divide by xterm's
    // measured cell dimensions; ceil() so the last cell tucks under
    // overflow:hidden flush with the right edge.
    const doFitNow = () => {
      const host = containerRef.current;
      if (!host) return;
      // _core / _renderService / dimensions are private but stable since
      // xterm 5; this is what FitAddon itself reads internally.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cell = (term as any)._core?._renderService?.dimensions?.css?.cell as
        | { width: number; height: number }
        | undefined;
      if (!cell || !cell.width || !cell.height) {
        try { fit.fit(); } catch { /* container detached */ }
        return;
      }
      const cols = Math.max(2, Math.ceil(host.clientWidth / cell.width));
      const rows = Math.max(1, Math.floor(host.clientHeight / cell.height));
      if (term.cols !== cols || term.rows !== rows) {
        try { term.resize(cols, rows); } catch { /* detached */ }
      }
    };

    // ResizeObserver catches font loads, sidebar toggles, and the initial
    // layout settle — not just window resizes. The rAF coalesces drag-resizes
    // so we don't ship one pty-resize message per animation frame.
    let rafId = 0;
    const safeFit = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(doFitNow);
    };
    const ro = new ResizeObserver(safeFit);
    ro.observe(containerRef.current);

    // Canvas renderer: ~5–10× faster than the DOM renderer and stays accurate
    // across font fallback (unlike WebGL, which caches its glyph atlas at
    // init and renders later font swaps at the wrong cell width). Loaded
    // after fonts.ready so the initial atlas uses the final font metrics.
    const loadCanvas = () => {
      try { term.loadAddon(new CanvasAddon()); } catch { /* fall back to DOM */ }
    };
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => { loadCanvas(); safeFit(); });
    } else {
      loadCanvas();
    }

    // Copy / paste / search via Ctrl+Shift+C/V/F — distinct from the pty's
    // own Ctrl+C (SIGINT) / Ctrl+V semantics.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyV') {
        navigator.clipboard.readText().then((t) => term.paste(t)).catch(() => {});
        return false;
      }
      if (e.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
      }
      if (e.code === 'KeyF') {
        const q = window.prompt('Find in scrollback:');
        if (q) search.findNext(q, { caseSensitive: false, regex: false });
        return false;
      }
      return true;
    });

    // Connection state machine — keeps the Terminal alive across reconnects
    // so the scrollback buffer survives a network blip.
    let ws: WebSocket | null = null;
    let attempts = 0;
    let wasConnected = false;
    let aborted = false;
    let reconnectTimer = 0;
    let pingTimer = 0;

    const stopKeepalive = () => {
      if (pingTimer) { window.clearInterval(pingTimer); pingTimer = 0; }
    };
    const startKeepalive = () => {
      stopKeepalive();
      pingTimer = window.setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
    };

    const connect = () => {
      if (aborted) return;
      attempts += 1;
      onConnState(wasConnected ? 'reconnecting' : 'connecting');

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPath = tab === 'console' ? 'console' : 'ssh';
      const token = localStorage.getItem('virtpilotToken') ?? '';
      // Token in the WebSocket subprotocol keeps the JWT out of URLs (and
      // therefore out of proxy/journal logs and browser history).
      const sock = new WebSocket(
        `${proto}//${window.location.host}/ws/${wsPath}?vm=${encodeURIComponent(name)}`,
        [`virtpilot.token.${token}`],
      );
      sock.binaryType = 'arraybuffer';
      ws = sock;

      sock.onopen = () => {
        wasConnected = true;
        attempts = 0;
        onConnState('connected');
        startKeepalive();
        // Tell the pty our current geometry up-front — the backend uses this
        // as the initial cols/rows so nano/vi launched immediately after
        // connect aren't drawn at the placeholder 220×50.
        sock.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        if (tab === 'console') {
          term.writeln('\r\n\x1b[2mConnected. Press Enter to continue…\x1b[0m\r\n');
        }
      };

      sock.onmessage = (e) => {
        if (typeof e.data === 'string') {
          term.write(e.data);
        } else {
          term.write(new Uint8Array(e.data as ArrayBuffer));
        }
      };

      sock.onclose = (e) => {
        stopKeepalive();
        if (ws === sock) ws = null;
        if (aborted) return;

        //  • 1000 / 1005 → clean close (session ended)
        //  • 1008       → auth/policy failure (re-auth needed; retrying loops)
        //  • never connected → don't loop forever on a permanently-broken
        //                      endpoint; surface the close and let the user
        //                      pick a different tab or fix the VM
        const unrecoverable = e.code === 1000 || e.code === 1005 || e.code === 1008;
        if (unrecoverable || !wasConnected) {
          onConnState('closed');
          term.writeln('\r\n\x1b[2m[Connection closed]\x1b[0m');
          return;
        }

        // Exponential backoff: 250 → 500 → 1000 → 2000ms, capped 5000ms.
        const delay = Math.min(250 * 2 ** Math.max(0, attempts - 1), 5000);
        onConnState('reconnecting');
        term.writeln(`\r\n\x1b[2m[Reconnecting in ${(delay / 1000).toFixed(1)}s…]\x1b[0m`);
        reconnectTimer = window.setTimeout(connect, delay);
      };

      sock.onerror = () => {
        // onclose follows; let it own the reconnect decision.
      };
    };

    // Keystrokes go out as binary frames so they can't be misinterpreted as
    // control JSON — a pasted `{"type":"resize",...}` would otherwise resize
    // the pty. Control messages (resize, ping) stay as text frames; backend
    // distinguishes via the `isBinary` flag.
    const encoder = new TextEncoder();
    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
    });
    term.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Synchronously fit before opening the WS so the initial resize message
    // carries real geometry rather than the xterm defaults (80×24).
    doFitNow();
    connect();

    return () => {
      aborted = true;
      stopKeepalive();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      ws?.close(1000, 'unmount');
      term.dispose();
      termRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply theme changes live — xterm.js v5 documents `term.options.theme = {...}`
  // as the runtime mutation API. Re-assigning a fresh object (not mutating in
  // place) is what triggers the re-render. Skip the very first run because the
  // mount effect already applied the initial theme via `new XTerm(...)`.
  const themeFirstRun = useRef(true);
  useEffect(() => {
    if (themeFirstRun.current) {
      themeFirstRun.current = false;
      return;
    }
    const term = termRef.current;
    if (!term) return;
    term.options.theme = { ...THEMES[themeId].palette };
  }, [themeId]);

  // No padding on xterm's parent — FitAddon doesn't subtract container
  // padding, so any here would make it overestimate rows by ~1 and clip the
  // bottom line (visible in nano). Terminal renders edge-to-edge.
  return <div ref={containerRef} className="vp-terminal-host flex-1 overflow-hidden" />;
}

interface ThemePickerProps {
  themeId: ThemeId;
  onChange: (id: ThemeId) => void;
}

function ThemePicker({ themeId, onChange }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = THEMES[themeId];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white"
        title="Terminal theme"
      >
        <Palette size={11} className="text-white/50" />
        <span className="tracking-tight">{active.name}</span>
        <ChevronDown size={11} className={cn('text-white/40 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1.5 w-56 overflow-hidden rounded-lg border border-white/10 bg-[#0d0d14]/95 shadow-[0_8px_24px_rgba(0,0,0,0.5)] ring-1 ring-white/[0.04] backdrop-blur"
        >
          <ul className="py-1">
            {THEME_ORDER.map((id) => {
              const t = THEMES[id];
              const isActive = id === themeId;
              return (
                <li key={id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => { onChange(id); setOpen(false); }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white',
                      isActive && 'text-white',
                    )}
                  >
                    <Check size={11} className={cn('shrink-0', isActive ? 'text-emerald-400' : 'invisible')} />
                    <span className="flex-1 truncate">{t.name}</span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      {[t.palette.red, t.palette.yellow, t.palette.green, t.palette.blue, t.palette.magenta].map((c, i) => (
                        <span
                          key={i}
                          className="h-2 w-2 rounded-full ring-1 ring-black/30"
                          style={{ background: c }}
                        />
                      ))}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function VncPane({ name, onConnState }: { name: string; onConnState: (s: ConnState) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    onConnState('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = localStorage.getItem('virtpilotToken') ?? '';
    const url = `${proto}//${window.location.host}/ws/vnc?vm=${encodeURIComponent(name)}`;

    let rfb: RFB;
    try {
      // noVNC accepts `wsProtocols` so the JWT can ride in Sec-WebSocket-Protocol
      // instead of the URL.
      rfb = new RFB(containerRef.current, url, { wsProtocols: [`virtpilot.token.${token}`] });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
    } catch {
      onConnState('error');
      return;
    }

    rfb.addEventListener('connect', () => onConnState('connected'));
    rfb.addEventListener('disconnect', (e) => {
      const evt = e as CustomEvent<{ clean: boolean }>;
      onConnState(evt.detail.clean ? 'closed' : 'error');
    });

    return () => {
      try { rfb.disconnect(); } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-hidden"
      style={{ background: '#000', cursor: 'default' }}
    />
  );
}

export function VmConsolePage() {
  const { uuid } = useParams<{ uuid: string }>();
  const [tab, setTab] = useState<Tab>('console');
  const [connState, setConnState] = useState<ConnState>('connecting');
  // Lazy initialiser so the localStorage read happens once at mount, not on
  // every render. Falls back to the default when storage is unavailable.
  const [themeId, setThemeId] = useState<ThemeId>(() => loadTerminalTheme());
  const handleThemeChange = (id: ThemeId) => {
    setThemeId(id);
    saveTerminalTheme(id);
  };
  const themeBg = THEMES[themeId].palette.background ?? '#09090f';
  // `window.opener` is set when this window was opened via window.open() from
  // a same-origin page (the Console button on the VMs list / VM detail). In
  // that case the page is a dedicated console pop-out — back-to-VM navigation
  // doesn't belong. Locked in at mount via useState lazy init: if the opener
  // tab closes later we keep treating this as a popup, otherwise the back
  // link would suddenly appear and trap the user inside the pop-out.
  const [isPopup] = useState(() => typeof window !== 'undefined' && window.opener !== null);
  const { data: vm } = useVm(uuid!);
  const rawAction = useVmAction(uuid!);
  const fire = (opts: { action: 'start' | 'stop' | 'reboot'; params?: Record<string, string> }, label: string) => {
    rawAction.mutate(opts, {
      onSuccess: () => toast.success(`${label} sent`),
      onError: (err: unknown) =>
        toast.error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`),
    });
  };
  const action = {
    isPending: rawAction.isPending,
    start:      () => fire({ action: 'start' }, 'Start'),
    reboot:     () => fire({ action: 'reboot' }, 'Reboot'),
    stop:       () => fire({ action: 'stop' }, 'Stop'),
    forceStop:  () => fire({ action: 'stop', params: { force: 'true' } }, 'Force stop'),
  };

  const isNotRunning = vm && vm.status !== 'running';

  return (
    <div className="flex h-screen flex-col" style={{ background: themeBg }}>
      {/* Header bar */}
      <div
        className="flex h-11 shrink-0 items-center gap-3 border-b px-5"
        style={{ borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.03)' }}
      >
        {/* Brand mark */}
        <img src="/vlogo-small.png" alt="VirtPilot" className="h-5 w-5 shrink-0 object-contain" />

        <span className="h-4 w-px bg-white/8" />

        {/* Back link — hidden in popup mode (no parent dashboard to return to) */}
        {isPopup ? (
          <span className="text-xs font-medium text-white/70">
            {vm?.name ?? uuid}
          </span>
        ) : (
          <Link
            to={`/vms/${uuid}`}
            className="flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
          >
            <ArrowLeft size={12} />
            {vm?.name ?? uuid}
          </Link>
        )}

        <span className="h-4 w-px bg-white/8" />

        {/* Tab switcher */}
        <div
          className="flex items-center gap-0.5 rounded-md p-0.5"
          style={{ background: 'rgba(255,255,255,0.05)' }}
        >
          <button
            onClick={() => setTab('console')}
            className={cn(
              'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
              tab === 'console'
                ? 'bg-white/10 text-white/80'
                : 'text-white/35 hover:text-white/60'
            )}
          >
            <Terminal size={11} />
            Console
          </button>
          <button
            onClick={() => setTab('ssh')}
            className={cn(
              'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
              tab === 'ssh'
                ? 'bg-white/10 text-white/80'
                : 'text-white/35 hover:text-white/60'
            )}
          >
            <Wifi size={11} />
            SSH
          </button>
          <button
            onClick={() => setTab('vnc')}
            className={cn(
              'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
              tab === 'vnc'
                ? 'bg-white/10 text-white/80'
                : 'text-white/35 hover:text-white/60'
            )}
          >
            <Monitor size={11} />
            VNC
          </button>
        </div>

        <span className="h-4 w-px bg-white/8" />

        {/* Connection state */}
        <div className="flex items-center gap-2">
          <span
            className={cn('h-1.5 w-1.5 rounded-full', connDotClass[connState])}
            style={
              connState === 'connected'
                ? { boxShadow: '0 0 5px 1px rgb(52 211 153 / 0.5)' }
                : undefined
            }
          />
          <span className="font-mono text-xs text-white/35">{connLabel[connState]}</span>
        </div>

        {/* VM action buttons — right aligned */}
        <div className="ml-auto flex items-center gap-1">
          {vm && vm.status !== 'running' && (
            <button
              onClick={action.start}
              disabled={action.isPending}
              title="Start"
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-emerald-400/70 transition-colors hover:bg-white/5 hover:text-emerald-400 disabled:opacity-40"
            >
              {action.isPending ? <Spinner className="h-2.5 w-2.5 text-white/60" /> : <Play size={11} />}
              Start
            </button>
          )}
          {vm?.status === 'running' && (
            <>
              <button
                onClick={action.reboot}
                disabled={action.isPending}
                title="Reboot"
                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-amber-400/70 transition-colors hover:bg-white/5 hover:text-amber-400 disabled:opacity-40"
              >
                {action.isPending ? <Spinner className="h-2.5 w-2.5 text-white/60" /> : <RefreshCw size={11} />}
                Reboot
              </button>
              <button
                onClick={action.stop}
                disabled={action.isPending}
                title="Stop"
                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-red-400/70 transition-colors hover:bg-white/5 hover:text-red-400 disabled:opacity-40"
              >
                {action.isPending ? <Spinner className="h-2.5 w-2.5 text-white/60" /> : <Square size={11} />}
                Stop
              </button>
              <button
                onClick={action.forceStop}
                disabled={action.isPending}
                title="Force stop (virsh destroy)"
                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-red-500/50 transition-colors hover:bg-white/5 hover:text-red-500 disabled:opacity-40"
              >
                {action.isPending ? <Spinner className="h-2.5 w-2.5 text-white/60" /> : <Zap size={11} />}
                Force Stop
              </button>
            </>
          )}
          <span className="ml-1 font-mono text-xs text-white/20">{tab}/{vm?.name ?? uuid}</span>
          <ThemePicker themeId={themeId} onChange={handleThemeChange} />
        </div>
      </div>

      {/* Indeterminate progress bar during (re)connect. */}
      <div className="relative h-0.5 shrink-0 bg-white/[0.04]">
        {(connState === 'connecting' || connState === 'reconnecting') && (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[vp-progress_1.4s_ease-in-out_infinite] bg-primary/80" />
        )}
      </div>

      {/* Pane — remounts on tab switch via key */}
      {isNotRunning ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Power size={24} className="text-white/15" />
          <p className="text-sm text-white/40">
            VM is <span className="font-mono">{vm.status}</span> — use Start above to boot it.
          </p>
        </div>
      ) : tab === 'vnc' ? (
        <VncPane key="vnc" name={uuid!} onConnState={setConnState} />
      ) : (
        <TerminalPane key={tab} name={uuid!} tab={tab} themeId={themeId} onConnState={setConnState} />
      )}
    </div>
  );
}
