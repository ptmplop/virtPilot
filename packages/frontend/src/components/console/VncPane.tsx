import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc/lib/rfb.js';
import { SessionBar, type SessionEnd } from './SessionBar';
import { matchShortcut, reconnectDelay, wsProtocols, wsUrl, type ConnState, type PaneAction } from './session';

/** What the workspace can do to the active display: keys the browser would keep for itself. */
export interface VncHandle {
  sendCombo: (combo: VncCombo) => void;
  /** Types text into the guest as keystrokes (US layout); resolves with how many characters it could type. */
  typeText: (text: string) => Promise<number>;
}

export type VncCombo = 'ctrl-alt-del' | 'ctrl-alt-f1' | 'ctrl-alt-f2' | 'ctrl-alt-backspace';

const XK = {
  shift: 0xffe1,
  ctrl: 0xffe3,
  alt: 0xffe9,
  del: 0xffff,
  backspace: 0xff08,
  enter: 0xff0d,
  tab: 0xff09,
  f1: 0xffbe,
  f2: 0xffbf,
};

// A US keyboard's keys for the printable ASCII range: the key's code, and whether Shift is
// held for it. The guest maps scancodes with its own layout, so this types correctly into
// a guest set to US English (most installers and cloud images).
const SHIFTED: Record<string, string> = {
  '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', $: 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7',
  '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', _: 'Minus', '+': 'Equal', '{': 'BracketLeft',
  '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period',
  '?': 'Slash', '~': 'Backquote',
};
const PLAIN: Record<string, string> = {
  ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
};

function keyFor(ch: string): { keysym: number; code: string; shift: boolean } | null {
  if (ch === '\n') return { keysym: XK.enter, code: 'Enter', shift: false };
  if (ch === '\t') return { keysym: XK.tab, code: 'Tab', shift: false };
  const cp = ch.charCodeAt(0);
  if (ch.length !== 1 || cp < 0x20 || cp > 0x7e) return null;
  if (/[a-z]/.test(ch)) return { keysym: cp, code: `Key${ch.toUpperCase()}`, shift: false };
  if (/[A-Z]/.test(ch)) return { keysym: cp, code: `Key${ch}`, shift: true };
  if (/[0-9]/.test(ch)) return { keysym: cp, code: `Digit${ch}`, shift: false };
  if (SHIFTED[ch]) return { keysym: cp, code: SHIFTED[ch], shift: true };
  if (PLAIN[ch]) return { keysym: cp, code: PLAIN[ch], shift: false };
  return null;
}

interface VncPaneProps {
  vmId: string;
  /** The ground around the scaled display (the terminal theme's, so panes match). */
  ground: string;
  reachable: boolean | null;
  stopped: { message: string; onPowerOn?: () => void; pending?: boolean } | null;
  /** When the VM list now shown was asked for (ms); see TerminalPane. */
  listAsOf: number;
  wakeKey: number;
  active: boolean;
  split: boolean;
  focusKey: number;
  onConnState: (state: ConnState) => void;
  onAction: (action: Exclude<PaneAction, 'clear'>) => void;
  onHandle: (handle: VncHandle | null) => void;
}

/**
 * The VM's graphical display through noVNC, scaled to the pane. QEMU shares the display
 * between viewers, so several panes (or windows) can show one VM at once.
 */
export function VncPane(props: VncPaneProps) {
  const { reachable, stopped, listAsOf, wakeKey, active, split, focusKey, ground } = props;
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const barButtonRef = useRef<HTMLButtonElement>(null);
  const [ended, setEnded] = useState<SessionEnd | null>(null);
  const [dialled, setDialled] = useState(false);
  const endedRef = useRef(ended);
  endedRef.current = ended;
  const dialRef = useRef<() => void>(() => {});
  const endedAtRef = useRef(0);
  const downAtRef = useRef(0);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let aborted = false;
    let attempts = 0;
    let retryTimer = 0;
    let connectedAt = 0;

    const setState = (s: ConnState) => latest.current.onConnState(s);

    const connect = () => {
      const screen = screenRef.current;
      if (aborted || !screen) return;
      setState(attempts > 0 ? 'reconnecting' : 'connecting');
      let rfb: RFB;
      try {
        // The token rides in the subprotocol, never in the URL.
        rfb = new RFB(screen, wsUrl('/ws/vnc', { vm: latest.current.vmId }), { wsProtocols: wsProtocols() });
      } catch {
        setState('error');
        setEnded({ title: 'Couldn’t connect', reason: null, failed: true });
        return;
      }
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = latest.current.ground;
      rfbRef.current = rfb;

      rfb.addEventListener('connect', () => {
        connectedAt = Date.now();
        setState('connected');
        if (latest.current.active) rfb.focus();
      });
      rfb.addEventListener('disconnect', (e) => {
        if (rfbRef.current === rfb) rfbRef.current = null;
        if (aborted) return;
        const { clean } = (e as CustomEvent<{ clean: boolean }>).detail;
        const held = connectedAt > 0 && Date.now() - connectedAt > 5_000;
        // A display that had been up a while and dropped while the VM still runs is a
        // network blip (or a VirtPilot restart) more often than not: try again, backing
        // off, before giving up. A display that held starts a fresh budget; only a first
        // dial that fails ends at once.
        if (held) attempts = 0;
        if ((held || attempts > 0) && latest.current.reachable === true && attempts < 6) {
          attempts += 1;
          connectedAt = 0;
          setState('reconnecting');
          retryTimer = window.setTimeout(connect, reconnectDelay(attempts));
          return;
        }
        const wasUp = connectedAt > 0 || attempts > 0;
        endedAtRef.current = Date.now();
        downAtRef.current = 0;
        setState(clean && wasUp ? 'closed' : 'error');
        setEnded(
          attempts >= 6
            ? { title: 'Reconnection failed', reason: null, failed: true }
            : clean && wasUp
              ? { title: 'Session ended', reason: null, failed: false }
              : { title: 'Couldn’t connect', reason: null, failed: true },
        );
      });
    };

    dialRef.current = () => {
      if (aborted || rfbRef.current) return;
      if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = 0; }
      attempts = 0;
      connectedAt = 0;
      setEnded(null);
      setDialled(true);
      connect();
    };

    const press = (keysym: number, code: string, down: boolean) => rfbRef.current?.sendKey(keysym, code, down);
    const combo = (keys: Array<[number, string]>) => {
      for (const [k, c] of keys) press(k, c, true);
      for (const [k, c] of [...keys].reverse()) press(k, c, false);
    };
    latest.current.onHandle({
      sendCombo: (which) => {
        const ctrlAlt: Array<[number, string]> = [[XK.ctrl, 'ControlLeft'], [XK.alt, 'AltLeft']];
        if (which === 'ctrl-alt-del') combo([...ctrlAlt, [XK.del, 'Delete']]);
        else if (which === 'ctrl-alt-f1') combo([...ctrlAlt, [XK.f1, 'F1']]);
        else if (which === 'ctrl-alt-f2') combo([...ctrlAlt, [XK.f2, 'F2']]);
        else combo([...ctrlAlt, [XK.backspace, 'Backspace']]);
        rfbRef.current?.focus();
      },
      typeText: async (text) => {
        let typed = 0;
        for (const ch of text.replace(/\r\n?/g, '\n')) {
          const key = keyFor(ch);
          if (!key || !rfbRef.current) continue;
          if (key.shift) press(XK.shift, 'ShiftLeft', true);
          press(key.keysym, key.code, true);
          press(key.keysym, key.code, false);
          if (key.shift) press(XK.shift, 'ShiftLeft', false);
          typed += 1;
          // A guest's keyboard buffer is small: a short gap keeps keys from being dropped.
          await new Promise((resolve) => window.setTimeout(resolve, 6));
        }
        rfbRef.current?.focus();
        return typed;
      },
    });

    return () => {
      aborted = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      latest.current.onHandle(null);
      try { rfbRef.current?.disconnect(); } catch { /* already gone */ }
      rfbRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Waiting for a VM that is off: nothing is connecting, so the header says so.
  useEffect(() => {
    if (reachable === false && !dialled) latest.current.onConnState('idle');
  }, [reachable, dialled]);

  // Dial once the VM can take a session, and again when it comes back after stopping,
  // so a graphical boot is on screen from the start. Only list readings asked for after
  // the session ended count (see TerminalPane).
  useEffect(() => {
    if (ended && reachable === false && listAsOf > endedAtRef.current) {
      downAtRef.current = Math.max(downAtRef.current, listAsOf);
    }
  }, [reachable, listAsOf, ended]);
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

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.background = ground;
  }, [ground]);

  const showBar = !!ended || (reachable === false && !dialled);
  useEffect(() => {
    if (!active) return;
    if (showBar) barButtonRef.current?.focus();
    else rfbRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusKey]);

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      // The display takes every key while it has focus, so the console's own tab and
      // split shortcuts are caught on the way in; everything else goes to the guest.
      onKeyDownCapture={(e) => {
        const action = matchShortcut(e.nativeEvent);
        if (!action || action === 'clear') return;
        e.preventDefault();
        e.stopPropagation();
        latest.current.onAction(action);
      }}
    >
      <div ref={screenRef} className="min-h-0 min-w-0 flex-1 overflow-hidden" style={{ background: ground }} />
      {showBar && (
        <SessionBar
          ref={barButtonRef}
          ended={ended}
          stopped={reachable === false ? stopped : null}
          onReconnect={() => dialRef.current()}
          split={split}
        />
      )}
    </div>
  );
}
