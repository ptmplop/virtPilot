// What every console session shares: its kinds, connection states and their words, the
// close codes that end a session, the reconnect schedule and the keyboard shortcuts.

export type SessionKind = 'console' | 'ssh' | 'vnc';

/** `idle`: waiting for the VM to be powered on, nothing dialled yet. */
export type ConnState = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'closed' | 'error';

export const KIND_ORDER: SessionKind[] = ['console', 'ssh', 'vnc'];

export const KIND_LABEL: Record<SessionKind, string> = {
  console: 'Console',
  ssh: 'SSH',
  vnc: 'VNC',
};

/** Each kind inside a sentence ("Open SSH on", "New tab: the serial console on web-01"). */
export const KIND_PHRASE: Record<SessionKind, string> = {
  console: 'the serial console',
  ssh: 'SSH',
  vnc: 'VNC',
};

/** What each kind is, for tooltips and the window title. */
export const KIND_HINT: Record<SessionKind, string> = {
  console: 'Serial console',
  ssh: 'SSH session',
  vnc: 'Graphical display (VNC)',
};

export const CONN_LABEL: Record<ConnState, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  connected: 'Connected',
  closed: 'Disconnected',
  error: 'Error',
};

// The connection state is a word, coloured only when something is wrong; the bar under
// the header shows motion while connecting. (Status glyphs are a VM's own state.)
export const CONN_TONE: Record<ConnState, string> = {
  idle: 'text-muted-foreground',
  connecting: 'text-muted-foreground',
  reconnecting: 'text-amber-300',
  connected: 'text-muted-foreground',
  closed: 'text-amber-300',
  error: 'text-red-300',
};

export const isLive = (state: ConnState) => state === 'connecting' || state === 'reconnecting';

/** The state a tab speaks for: its worst pane's. */
export function worstState(states: ConnState[]): ConnState {
  for (const s of ['error', 'closed', 'reconnecting', 'connecting', 'idle'] as const) {
    if (states.includes(s)) return s;
  }
  return 'connected';
}

// Stop retrying after this many attempts, so a backend that stays down isn't dialled
// forever; the pane's Reconnect bar takes over from there.
export const MAX_RECONNECT_ATTEMPTS = 10;

/** Exponential backoff (250ms doubling, capped at 5s) with ±20% jitter, so every open
    session doesn't redial in lockstep after a backend restart. */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(250 * 2 ** Math.max(0, attempt - 1), 5000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Close codes that end a session rather than start a retry: 1000/1005 a clean end (the
 * shell exited), 1008 refused (signed out, bad request), 1011 the backend could not open
 * it (no IP address, no credentials, an SSH error), 4001 the VM is off. Retrying those
 * only loops; the pane offers Reconnect, or Power on, instead.
 */
export const isFinalClose = (code: number) =>
  code === 1000 || code === 1005 || code === 1008 || code === 1011 || code === CLOSE_VM_DOWN;

/** The backend's close code for "the VM is not running" (it is off): the pane offers Power on. */
export const CLOSE_VM_DOWN = 4001;

/** The words after "Session ended" on a pane's Reconnect bar. */
export function endReason(code: number, reason: string, wasConnected: boolean): string | null {
  if (reason && reason !== 'unmount') return reason;
  if (code === 1006) return wasConnected ? 'The connection dropped' : 'The server could not be reached';
  return null;
}

export function wsUrl(path: string, params: Record<string, string>): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}?${new URLSearchParams(params).toString()}`;
}

/** The token rides in the subprotocol, which keeps it out of URLs and proxy logs. Read
    at each dial, so a reconnect uses the session as it is now. */
export const wsProtocols = () => [`virtpilot.token.${localStorage.getItem('virtpilotToken') ?? ''}`];

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);

export type PaneAction = 'clear' | 'split-right' | 'split-down' | 'new-tab' | 'next-tab' | 'prev-tab';

// Cmd+D / Cmd+Shift+D split (iTerm), Ctrl+Shift+` new tab (VS Code). Elsewhere Cmd is
// Ctrl+Shift, so plain Ctrl+K / Ctrl+D keep their shell meanings (kill-line, EOF).
// Ctrl+Shift+PageDown / PageUp step through the tabs everywhere: a terminal keeps Tab for
// the shell, so this is the keyboard's way to the other tabs.
export function matchShortcut(e: KeyboardEvent): PaneAction | null {
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
    if (e.code === 'Backquote') return 'new-tab';
    if (e.code === 'PageDown') return 'next-tab';
    if (e.code === 'PageUp') return 'prev-tab';
  }
  if (IS_MAC) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.code === 'KeyK' && !e.shiftKey) return 'clear';
    if (e.code === 'KeyD') return e.shiftKey ? 'split-down' : 'split-right';
    return null;
  }
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  if (e.code === 'KeyK') return 'clear';
  if (e.code === 'KeyD') return 'split-right';
  return null;
}

export const SHORTCUT = {
  newTab: 'Ctrl+Shift+`',
  nextTab: 'Ctrl+Shift+PgDn',
  splitRight: IS_MAC ? 'Cmd+D' : 'Ctrl+Shift+D',
  splitDown: IS_MAC ? 'Cmd+Shift+D' : undefined,
  clear: IS_MAC ? 'Cmd+K' : 'Ctrl+Shift+K',
  find: 'Ctrl+Shift+F',
};
