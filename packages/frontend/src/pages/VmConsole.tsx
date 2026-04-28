import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Cpu, Loader2, Monitor, Play, Power, RefreshCw, Square, Terminal, Wifi, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import RFB from '@novnc/novnc/lib/rfb.js';
import { cn } from '@/lib/cn';
import { useVm, useVmAction } from '@/hooks/useVms';

type ConnState = 'connecting' | 'connected' | 'closed' | 'error';
type Tab = 'console' | 'ssh' | 'vnc';

const connLabel: Record<ConnState, string> = {
  connecting: 'Connecting…',
  connected:  'Connected',
  closed:     'Disconnected',
  error:      'Error',
};

const connDotClass: Record<ConnState, string> = {
  connecting: 'bg-amber-400 animate-pulse',
  connected:  'bg-emerald-500',
  closed:     'bg-slate-500',
  error:      'bg-red-500',
};

const THEME = {
  background:   '#09090f',
  foreground:   '#d4d9e8',
  cursor:       '#4d9ef5',
  cursorAccent: '#09090f',
  black:        '#1a1b26',
  red:          '#f7768e',
  green:        '#9ece6a',
  yellow:       '#e0af68',
  blue:         '#7aa2f7',
  magenta:      '#bb9af7',
  cyan:         '#7dcfff',
  white:        '#a9b1d6',
  brightBlack:  '#414868',
  brightWhite:  '#c0caf5',
};

interface TerminalPaneProps {
  name: string;
  tab: 'console' | 'ssh';
  onConnState: (s: ConnState) => void;
}

function TerminalPane({ name, tab, onConnState }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: THEME,
      fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    requestAnimationFrame(() => fit.fit());

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsPath = tab === 'console' ? 'console' : 'ssh';
    const token = localStorage.getItem('virtpilotToken') ?? '';
    const ws = new WebSocket(
      `${proto}//${window.location.host}/ws/${wsPath}?vm=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`
    );

    onConnState('connecting');

    ws.onopen = () => {
      onConnState('connected');
      if (tab === 'console') {
        term.writeln('\r\n\x1b[2mConnected. Press Enter to continue…\x1b[0m\r\n');
      }
    };
    ws.onmessage = (e) => term.write(e.data as string);
    ws.onclose = () => {
      onConnState('closed');
      term.writeln('\r\n\r\n\x1b[2m[Connection closed]\x1b[0m');
    };
    ws.onerror = () => {
      onConnState('error');
      term.writeln('\r\n\r\n\x1b[31m[Connection error]\x1b[0m');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      ws.close();
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="flex-1 overflow-hidden p-2" />;
}

function VncPane({ name, onConnState }: { name: string; onConnState: (s: ConnState) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    onConnState('connecting');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = localStorage.getItem('virtpilotToken') ?? '';
    const url = `${proto}//${window.location.host}/ws/vnc?vm=${encodeURIComponent(name)}&token=${encodeURIComponent(token)}`;

    let rfb: RFB;
    try {
      rfb = new RFB(containerRef.current, url);
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
  const { name } = useParams<{ name: string }>();
  const [tab, setTab] = useState<Tab>('console');
  const [connState, setConnState] = useState<ConnState>('connecting');
  const { data: vm } = useVm(name!);
  const rawAction = useVmAction(name!);
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
    <div className="flex h-screen flex-col" style={{ background: '#09090f' }}>
      {/* Header bar */}
      <div
        className="flex h-11 shrink-0 items-center gap-3 border-b px-5"
        style={{ borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.03)' }}
      >
        {/* Brand mark */}
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-white/10"
          style={{ background: 'hsl(214 100% 62% / 0.15)' }}
        >
          <Cpu size={12} className="text-primary" />
        </div>

        <span className="h-4 w-px bg-white/8" />

        {/* Back link */}
        <Link
          to={`/vms/${name}`}
          className="flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
        >
          <ArrowLeft size={12} />
          {name}
        </Link>

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
              {action.isPending ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
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
                {action.isPending ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Reboot
              </button>
              <button
                onClick={action.stop}
                disabled={action.isPending}
                title="Stop"
                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-red-400/70 transition-colors hover:bg-white/5 hover:text-red-400 disabled:opacity-40"
              >
                {action.isPending ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} />}
                Stop
              </button>
              <button
                onClick={action.forceStop}
                disabled={action.isPending}
                title="Force stop (virsh destroy)"
                className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-red-500/50 transition-colors hover:bg-white/5 hover:text-red-500 disabled:opacity-40"
              >
                {action.isPending ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
                Force Stop
              </button>
            </>
          )}
          <span className="ml-1 font-mono text-xs text-white/20">{tab}/{name}</span>
        </div>
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
        <VncPane key="vnc" name={name!} onConnState={setConnState} />
      ) : (
        <TerminalPane key={tab} name={name!} tab={tab} onConnState={setConnState} />
      )}
    </div>
  );
}
