import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronDown,
  ChevronLeft,
  Columns2,
  Keyboard,
  Monitor,
  Palette,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Rows2,
  SquareTerminal,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { Tooltip } from '@/components/ui/Tooltip';
import { StatusBadge, StatusGlyph } from '@/components/ui/Badge';
import { VmLogo } from '@/components/ui/OsLogoPicker';
import { useVmAction, useVms } from '@/hooks/useVms';
import { useHostName } from '@/hooks/useSystemStats';
import { useLogoStore } from '@/store/logoStore';
import { osSlugFromImage } from '@/data/templateSets';
import { THEME_ORDER, THEMES, type ThemeId } from '@/lib/terminalThemes';
import { cn } from '@/lib/cn';
import type { VmStatus, VmSummary } from '@/types';
import { SplitHandle } from './SplitHandle';
import { TerminalPane } from './TerminalPane';
import { VncPane, type VncCombo, type VncHandle } from './VncPane';
import {
  CONN_LABEL,
  CONN_TONE,
  KIND_HINT,
  KIND_LABEL,
  KIND_ORDER,
  KIND_PHRASE,
  SHORTCUT,
  isLive,
  matchShortcut,
  worstState,
  type ConnState,
  type PaneAction,
  type SessionKind,
} from './session';

const MAX_PANES = 4;

/** One session in a tab. A pane that changes kind becomes a new pane (a new session). */
interface Pane {
  id: number;
  kind: SessionKind;
}

interface Row {
  id: number;
  panes: Pane[];
  /** Flex weights, parallel to `panes`. */
  sizes: number[];
}

export interface ConsoleTab {
  id: number;
  /** The VM every pane in this tab connects to. */
  vmId: string;
  /** A name given by double-click or F2; otherwise the shell's title, then the VM's name. */
  name?: string;
  /** The title the first pane's shell set. */
  title?: string;
  /** New output arrived while the tab was in the background. */
  activity?: boolean;
  rows: Row[];
  /** Flex weights, parallel to `rows`. */
  rowSizes: number[];
  /** The pane that has the cursor whenever this tab is shown. */
  focusPaneId: number;
}

/** A request to open a VM from outside the window (the dashboard's Console buttons). */
export interface OpenRequest {
  vmId: string;
  nonce: number;
}

const KIND_ICON: Record<SessionKind, typeof Terminal> = {
  console: SquareTerminal,
  ssh: Terminal,
  vnc: Monitor,
};

// The open tabs are kept for this window only, so a reload brings them back (each
// session dials again) instead of leaving one tab.
const STORE_KEY = 'virtpilotConsoleTabs';

interface StoredLayout {
  routeVm: string;
  tabs: ConsoleTab[];
  activeTabId: number;
}

function loadLayout(routeVm: string): StoredLayout | null {
  try {
    // Only a reload of this console page: reloading another page of the app and then
    // opening a console starts fresh.
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav?.type !== 'reload' || new URL(nav.name).pathname !== window.location.pathname) return null;
    const stored = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? 'null') as StoredLayout | null;
    if (!stored || stored.routeVm !== routeVm || !Array.isArray(stored.tabs) || stored.tabs.length === 0) return null;
    const valid = stored.tabs.every((t) => typeof t.vmId === 'string' && Array.isArray(t.rows) && t.rows.length > 0);
    return valid ? stored : null;
  } catch {
    return null;
  }
}

function saveLayout(layout: StoredLayout) {
  try {
    sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({ ...layout, tabs: layout.tabs.map(({ activity: _a, title: _t, ...rest }) => rest) }),
    );
  } catch { /* storage unavailable: a reload starts over */ }
}

const panesOf = (t: ConsoleTab) => t.rows.flatMap((r) => r.panes);
const paneCount = (t: ConsoleTab) => t.rows.reduce((n, r) => n + r.panes.length, 0);
const focusedPane = (t: ConsoleTab) => panesOf(t).find((p) => p.id === t.focusPaneId) ?? t.rows[0].panes[0];

/** Swap two neighbouring weights in a list. */
const withPair = (list: number[], index: number, first: number, second: number) =>
  list.map((w, i) => (i === index ? first : i === index + 1 ? second : w));

const STATUS_WORD: Record<VmStatus, string> = {
  running: 'Running',
  stopped: 'Stopped',
  paused: 'Paused',
  crashed: 'Crashed',
  unknown: 'Unknown',
};

interface ConsoleWorkspaceProps {
  routeVm: string;
  isPopup: boolean;
  themeId: ThemeId;
  onThemeChange: (id: ThemeId) => void;
  openRequest: OpenRequest | null;
}

/**
 * The console window: tabs, each on one VM, holding up to four split panes, each its own
 * session (serial console, SSH or VNC). Tabs in the background stay mounted, so their
 * sessions and scrollback survive switching. The header speaks for the active tab's VM
 * and its focused pane.
 */
export function ConsoleWorkspace({ routeVm, isPopup, themeId, onThemeChange, openRequest }: ConsoleWorkspaceProps) {
  const uid = useId();
  const [initial] = useState(() => {
    const stored = loadLayout(routeVm);
    if (stored) {
      const ids = stored.tabs.flatMap((t) => [t.id, t.focusPaneId, ...t.rows.flatMap((r) => [r.id, ...r.panes.map((p) => p.id)])]);
      const active = stored.tabs.find((t) => t.id === stored.activeTabId) ?? stored.tabs[0];
      return { tabs: stored.tabs, activeTabId: active.id, nextId: Math.max(...ids) + 1 };
    }
    return {
      tabs: [{ id: 3, vmId: routeVm, rows: [{ id: 2, panes: [{ id: 1, kind: 'console' as SessionKind }], sizes: [1] }], rowSizes: [1], focusPaneId: 1 }],
      activeTabId: 3,
      nextId: 4,
    };
  });
  const nextIdRef = useRef(initial.nextId);
  const newId = () => nextIdRef.current++;
  const [tabs, setTabs] = useState<ConsoleTab[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState(initial.activeTabId);
  const [paneConn, setPaneConn] = useState<Record<number, ConnState>>({});
  const [focusNonce, setFocusNonce] = useState(0);
  const [wake, setWake] = useState<Record<string, number>>({});
  const [editingTabId, setEditingTabId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const renameRef = useRef<number | null>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const focusTabRef = useRef<number | null>(null);
  const vncHandles = useRef(new Map<number, VncHandle>());

  const vmsQuery = useVms();
  const vms = vmsQuery.data;
  // When the VM list on screen was asked for. A poll begun before a VM stopped can still
  // answer "running" after it; the panes use this to tell such a reading from a new one.
  const listAskedAt = useRef(0);
  const [listAsOf, setListAsOf] = useState(0);
  useEffect(() => {
    if (vmsQuery.isFetching) listAskedAt.current = Date.now();
  }, [vmsQuery.isFetching]);
  useEffect(() => {
    if (vmsQuery.dataUpdatedAt) setListAsOf(listAskedAt.current || vmsQuery.dataUpdatedAt);
  }, [vmsQuery.dataUpdatedAt]);
  const vmById = useMemo(() => new Map((vms ?? []).map((v) => [v.id, v])), [vms]);
  const chosenLogos = useLogoStore((s) => s.vms);

  // A session that ended on a VM the list now shows stopped is quiet, not a fault: the
  // same words and tone as one that never dialled.
  const shown = (s: ConnState, vmId: string): ConnState =>
    s === 'closed' && vmById.get(vmId)?.status === 'stopped' ? 'idle' : s;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const activePane = focusedPane(activeTab);
  const activeVm = vmById.get(activeTab.vmId);
  const activeConn = shown(paneConn[activePane.id] ?? 'connecting', activeTab.vmId);

  useEffect(() => {
    saveLayout({ routeVm, tabs, activeTabId });
  }, [routeVm, tabs, activeTabId]);

  // ── Labels ────────────────────────────────────────────────────────────────
  // A tab reads as its given name, else its shell's title, else its VM's name; two
  // tabs that would read the same are numbered in the order they were opened.
  const labels = useMemo(() => {
    const base = (t: ConsoleTab) => t.name ?? t.title ?? vmById.get(t.vmId)?.name ?? (vms ? 'Unknown VM' : '…');
    const counts = new Map<string, number>();
    const out = new Map<number, string>();
    for (const t of tabs) {
      const b = base(t);
      const n = (counts.get(b) ?? 0) + 1;
      counts.set(b, n);
      out.set(t.id, n === 1 ? b : `${b} (${n})`);
    }
    return out;
  }, [tabs, vmById, vms]);

  // The window is named for what it shows: the VM first, so it survives truncation in
  // a taskbar or window switcher.
  const host = useHostName();
  const activeLabel = labels.get(activeTab.id) ?? '';
  useEffect(() => {
    const vmName = activeVm?.name;
    document.title = [vmName ?? activeLabel, KIND_LABEL[activePane.kind], host, 'VirtPilot'].filter(Boolean).join(' · ');
  }, [activeVm?.name, activeLabel, activePane.kind, host]);

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const makeTab = (vmId: string, kind: SessionKind): ConsoleTab => {
    const paneId = newId();
    return { id: newId(), vmId, rows: [{ id: newId(), panes: [{ id: paneId, kind }], sizes: [1] }], rowSizes: [1], focusPaneId: paneId };
  };

  const selectTab = useCallback((tab: ConsoleTab) => {
    setActiveTabId(tab.id);
    if (tab.activity) setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, activity: false } : t)));
    // Put the cursor in its terminal, also when the tab was already selected.
    setFocusNonce((n) => n + 1);
  }, []);

  const openTab = (vmId: string, kind: SessionKind) => {
    const tab = makeTab(vmId, kind);
    setTabs((ts) => [...ts, tab]);
    setActiveTabId(tab.id);
    setFocusNonce((n) => n + 1);
  };

  // The dashboard's Console button for a VM this window already shows brings its tab
  // forward; any other VM opens in a new tab.
  const lastRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || openRequest.nonce === lastRequest.current) return;
    lastRequest.current = openRequest.nonce;
    const existing = tabs.find((t) => t.vmId === openRequest.vmId);
    if (existing) selectTab(existing);
    else openTab(openRequest.vmId, 'console');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  const stepTab = (delta: 1 | -1) => {
    if (tabs.length < 2) return;
    const at = tabs.findIndex((t) => t.id === activeTabId);
    selectTab(tabs[(at + delta + tabs.length) % tabs.length]);
  };

  const forgetPanes = (ids: number[]) => {
    setPaneConn((prev) => {
      const copy = { ...prev };
      for (const id of ids) delete copy[id];
      return copy;
    });
    for (const id of ids) vncHandles.current.delete(id);
  };

  const closeTab = (tabId: number) => {
    if (tabs.length === 1) return; // the window always keeps one session
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const closing = tabs[idx];
    const rest = tabs.filter((t) => t.id !== tabId);
    setTabs(rest);
    if (activeTabId === tabId) {
      setActiveTabId(rest[Math.min(idx, rest.length - 1)].id);
      setFocusNonce((n) => n + 1);
    }
    forgetPanes(panesOf(closing).map((p) => p.id));
  };

  const startRename = (tab: ConsoleTab) => {
    renameRef.current = tab.id;
    setEditingTabId(tab.id);
    setEditName(labels.get(tab.id) ?? '');
  };

  const finishRename = (save: boolean, refocus: boolean) => {
    const id = renameRef.current;
    if (id === null) return;
    renameRef.current = null;
    const name = editName.trim();
    // An emptied name goes back to the automatic one.
    if (save) setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, name: name || undefined } : t)));
    setEditingTabId(null);
    if (refocus) setFocusNonce((n) => n + 1);
  };

  const handleTitle = (paneId: number, title: string) => {
    const trimmed = title.trim().slice(0, 80);
    setTabs((ts) => {
      const tab = ts.find((t) => t.rows[0].panes[0].id === paneId);
      if (!tab || tab.title === (trimmed || undefined)) return ts;
      return ts.map((t) => (t.id === tab.id ? { ...t, title: trimmed || undefined } : t));
    });
  };

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const markActivity = useCallback((tabId: number) => {
    if (tabId === activeTabIdRef.current) return;
    setTabs((ts) => (ts.some((t) => t.id === tabId && !t.activity) ? ts.map((t) => (t.id === tabId ? { ...t, activity: true } : t)) : ts));
  }, []);

  // ── Panes ─────────────────────────────────────────────────────────────────
  const setFocusPane = (tabId: number, paneId: number) =>
    setTabs((ts) => (ts.some((t) => t.id === tabId && t.focusPaneId !== paneId) ? ts.map((t) => (t.id === tabId ? { ...t, focusPaneId: paneId } : t)) : ts));

  const splitPane = (dir: 'right' | 'down') => {
    if (paneCount(activeTab) >= MAX_PANES) return;
    const pane: Pane = { id: newId(), kind: activePane.kind };
    const newRowId = newId();
    const rowIdx = Math.max(0, activeTab.rows.findIndex((r) => r.panes.some((p) => p.id === activePane.id)));
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== activeTab.id) return t;
        if (dir === 'right') {
          return {
            ...t,
            focusPaneId: pane.id,
            rows: t.rows.map((r, i) => {
              if (i !== rowIdx) return r;
              // The new pane takes half of the one it splits.
              const idx = r.panes.findIndex((p) => p.id === activePane.id);
              const at = idx === -1 ? r.panes.length : idx + 1;
              const sizes = [...r.sizes];
              const share = idx === -1 ? 1 : sizes[idx] / 2;
              if (idx !== -1) sizes[idx] = share;
              sizes.splice(at, 0, share);
              return { ...r, panes: [...r.panes.slice(0, at), pane, ...r.panes.slice(at)], sizes };
            }),
          };
        }
        const rows = [...t.rows];
        const rowSizes = [...t.rowSizes];
        const share = rowSizes[rowIdx] / 2;
        rowSizes[rowIdx] = share;
        rows.splice(rowIdx + 1, 0, { id: newRowId, panes: [pane], sizes: [1] });
        rowSizes.splice(rowIdx + 1, 0, share);
        return { ...t, rows, rowSizes, focusPaneId: pane.id };
      }),
    );
    setFocusNonce((n) => n + 1);
  };

  const closePane = (tab: ConsoleTab, paneId: number) => {
    if (paneCount(tab) === 1) {
      closeTab(tab.id);
      return;
    }
    // The space it leaves goes to its neighbour (the pane or row before it, else after).
    const rowIdx = tab.rows.findIndex((r) => r.panes.some((p) => p.id === paneId));
    const row = tab.rows[rowIdx];
    let rows = tab.rows;
    let rowSizes = tab.rowSizes;
    if (row.panes.length > 1) {
      const idx = row.panes.findIndex((p) => p.id === paneId);
      const sizes = row.sizes.filter((_, i) => i !== idx);
      sizes[Math.max(0, idx - 1)] += row.sizes[idx];
      rows = tab.rows.map((r, i) => (i === rowIdx ? { ...r, panes: r.panes.filter((p) => p.id !== paneId), sizes } : r));
    } else {
      rowSizes = tab.rowSizes.filter((_, i) => i !== rowIdx);
      rowSizes[Math.max(0, rowIdx - 1)] += tab.rowSizes[rowIdx];
      rows = tab.rows.filter((_, i) => i !== rowIdx);
    }
    const flat = rows.flatMap((r) => r.panes);
    const focusPaneId = tab.focusPaneId === paneId ? flat[flat.length - 1].id : tab.focusPaneId;
    // The first pane's shell named the tab: once it is gone, so is its title.
    const title = tab.rows[0].panes[0].id === paneId ? undefined : tab.title;
    setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, rows, rowSizes, focusPaneId, title } : t)));
    if (tab.id === activeTabId) setFocusNonce((n) => n + 1);
    forgetPanes([paneId]);
  };

  // A different kind for the focused pane is a new session in its place.
  const switchKind = (kind: SessionKind) => {
    if (activePane.kind === kind) return;
    const pane: Pane = { id: newId(), kind };
    setTabs((ts) =>
      ts.map((t) =>
        t.id !== activeTab.id
          ? t
          : {
              ...t,
              // The first pane's shell named the tab; a new session starts over.
              title: t.rows[0].panes[0].id === activePane.id ? undefined : t.title,
              focusPaneId: pane.id,
              rows: t.rows.map((r) => ({ ...r, panes: r.panes.map((p) => (p.id === activePane.id ? pane : p)) })),
            },
      ),
    );
    forgetPanes([activePane.id]);
    setFocusNonce((n) => n + 1);
  };

  const resizeRows = (tabId: number, index: number, first: number, second: number) =>
    setTabs((ts) => ts.map((t) => (t.id === tabId ? { ...t, rowSizes: withPair(t.rowSizes, index, first, second) } : t)));

  const resizePanes = (tabId: number, rowId: number, index: number, first: number, second: number) =>
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId
          ? { ...t, rows: t.rows.map((r) => (r.id === rowId ? { ...r, sizes: withPair(r.sizes, index, first, second) } : r)) }
          : t,
      ),
    );

  const onPaneAction = (action: Exclude<PaneAction, 'clear'>) => {
    if (action === 'new-tab') openTab(activeTab.vmId, activePane.kind);
    else if (action === 'next-tab') stepTab(1);
    else if (action === 'prev-tab') stepTab(-1);
    else if (action === 'split-right') splitPane('right');
    else splitPane('down');
  };

  // The tab shortcuts work wherever focus is in the window: a terminal or a display
  // claims its own keys first (and marks them handled), this catches the rest.
  const onPaneActionRef = useRef(onPaneAction);
  onPaneActionRef.current = onPaneAction;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = matchShortcut(e);
      if (!action || action === 'clear') return;
      e.preventDefault();
      onPaneActionRef.current(action);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Power ─────────────────────────────────────────────────────────────────
  const power = useVmAction(activeTab.vmId);
  const fire = (action: 'start' | 'stop' | 'reboot', label: string, force = false) => {
    const vmId = activeTab.vmId;
    power.mutate(
      { action, params: force ? { force: 'true' } : undefined },
      {
        onSuccess: () => {
          toast.success(`${label} sent`);
          // Sessions on this VM that were waiting for it dial now, not on the next poll,
          // so a serial console shows the boot from its first line.
          if (action === 'start') setWake((w) => ({ ...w, [vmId]: (w[vmId] ?? 0) + 1 }));
        },
        onError: (err: unknown) => toast.error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`),
      },
    );
  };

  // ── Keyboard on the tab strip ─────────────────────────────────────────────
  // The tabs take one tab stop (the selected one); arrows, Home and End move between
  // them, Enter or Space opens one (manual activation: opening moves the cursor into the
  // terminal, so following focus would leave the strip after one key).
  const onTablistKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const list = Array.from(tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const at = list.indexOf(e.target as HTMLElement);
    if (at === -1) return; // the rename field keeps its own arrow keys
    e.preventDefault();
    const n = list.length;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'ArrowRight' ? (at + 1) % n : (at - 1 + n) % n;
    list[to].focus();
    list[to].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, tab: ConsoleTab, index: number) => {
    if (e.key === 'F2') {
      e.preventDefault();
      startRename(tab);
    } else if (e.key === 'Delete' && tabs.length > 1) {
      e.preventDefault();
      const rest = tabs.filter((t) => t.id !== tab.id);
      focusTabRef.current = rest[Math.min(index, rest.length - 1)].id;
      closeTab(tab.id);
    }
  };

  useEffect(() => {
    const id = focusTabRef.current;
    if (id === null) return;
    focusTabRef.current = null;
    tablistRef.current?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus();
  });

  // Keep the selected tab in view: new tabs are added at the end of a strip that may scroll.
  useEffect(() => {
    tablistRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  // Which ends of a crowded strip have tabs out of sight: those edges fade.
  const [hidden, setHidden] = useState({ start: false, end: false });
  const measureStrip = () => {
    const el = tablistRef.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setHidden((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };
  useEffect(measureStrip);
  useEffect(() => {
    window.addEventListener('resize', measureStrip);
    return () => window.removeEventListener('resize', measureStrip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── VM state, per tab ─────────────────────────────────────────────────────
  // Whether a VM can take a session: running or paused can; stopped or crashed can't;
  // null while the list hasn't loaded. A VM missing from a loaded list was deleted.
  const reachableOf = (vm: VmSummary | undefined): boolean | null => {
    // The list failed to load: dial anyway, as the backend says soon enough if it can't.
    if (!vms) return vmsQuery.isError ? true : null;
    if (!vm) return false;
    return vm.status !== 'stopped' && vm.status !== 'crashed';
  };
  // Said when the backend finds the VM off before the list does.
  const downOf = (vmId: string) => ({
    message: `${vmById.get(vmId)?.name ?? 'The VM'} is stopped`,
    onPowerOn: vmId === activeTab.vmId ? () => fire('start', 'Power on') : undefined,
    pending: power.isPending,
  });
  const stoppedOf = (vmId: string) => {
    const vm = vmById.get(vmId);
    if (!vms) return null;
    if (!vm) return { message: 'This VM no longer exists' };
    if (vm.status === 'crashed') return { message: `${vm.name} has crashed. Force it off from the power menu` };
    if (vm.status !== 'stopped') return null;
    return {
      message: `${vm.name} is stopped`,
      onPowerOn: vmId === activeTab.vmId ? () => fire('start', 'Power on') : undefined,
      pending: power.isPending,
    };
  };

  const ground = THEMES[themeId].palette.background ?? '#0E121A';
  const splitDisabled = paneCount(activeTab) >= MAX_PANES;
  const tabState = (t: ConsoleTab) => worstState(panesOf(t).map((p) => shown(paneConn[p.id] ?? 'connecting', t.vmId)));

  // ── VNC keys ──────────────────────────────────────────────────────────────
  // Keys can only go to a display that is up.
  const vncHandle = activePane.kind === 'vnc' && activeConn === 'connected' ? vncHandles.current.get(activePane.id) : undefined;
  const sendCombo = (combo: VncCombo) => vncHandles.current.get(activePane.id)?.sendCombo(combo);
  const typeClipboard = async () => {
    const handle = vncHandles.current.get(activePane.id);
    if (!handle) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast.error('Couldn’t read the clipboard. Allow clipboard access for this site and try again.');
      return;
    }
    if (!text) {
      toast.info('The clipboard is empty');
      return;
    }
    const LIMIT = 4000;
    const chars = Array.from(text.replace(/\r\n?/g, '\n')).slice(0, LIMIT);
    const typed = await handle.typeText(chars.join(''));
    const skipped = chars.length - typed;
    if (typed === 0) toast.error('Nothing typed: these characters have no key on a US keyboard');
    else if (skipped > 0 || text.length > LIMIT) {
      toast.warning(`Typed ${typed} characters`, {
        description: skipped > 0 ? `${skipped} had no key on a US keyboard and were left out.` : `Only the first ${LIMIT} were typed.`,
      });
    } else toast.success(`Typed ${typed} characters`);
  };

  const vmName = activeVm?.name ?? (vms ? 'Unknown VM' : '…');
  const vmStatus = activeVm?.status;
  const logoSlug = activeVm ? chosenLogos[activeVm.name] ?? osSlugFromImage(activeVm.sourceTemplateFilename) : undefined;

  const powerItems: MenuItem[] =
    vmStatus === 'running'
      ? [
          { label: 'Reboot', hint: 'ACPI', icon: <RotateCcw size={14} />, onSelect: () => fire('reboot', 'Reboot') },
          { label: 'Power off', hint: 'ACPI', icon: <Power size={14} />, onSelect: () => fire('stop', 'Power off') },
          { label: 'Hard reset', hint: 'immediate', icon: <Zap size={14} />, onSelect: () => fire('reboot', 'Hard reset', true), separated: true },
          { label: 'Force off', hint: 'immediate', icon: <PowerOff size={14} />, onSelect: () => fire('stop', 'Force off', true), danger: true },
        ]
      : [{ label: 'Force off', hint: 'immediate', icon: <PowerOff size={14} />, onSelect: () => fire('stop', 'Force off', true), danger: true }];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The header speaks for the active tab: its VM (with its own state and power), the
          kind of session in the focused pane, and how that session is doing. */}
      <header className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:gap-3 sm:px-4">
        <img src="/brand/virtpilot-symbol-small-dark.svg" alt="" aria-hidden className="hidden h-5 w-5 shrink-0 sm:block" />
        <span aria-hidden className="hidden h-5 w-px shrink-0 bg-border sm:block" />

        <div className="flex min-w-0 items-center gap-2.5">
          {isPopup ? (
            <span className="flex min-w-0 items-center gap-2 text-[13.5px] font-semibold text-foreground">
              <span className="hidden shrink-0 sm:inline-flex"><VmLogo slug={logoSlug} size={18} /></span>
              <span className="min-w-0 truncate">{vmName}</span>
            </span>
          ) : (
            <Link
              to={`/vms/${activeTab.vmId}`}
              className="group flex h-8 min-w-0 items-center gap-2 rounded-md text-[13.5px] font-semibold text-foreground transition-colors hover:text-primary"
            >
              <ChevronLeft aria-hidden size={15} className="-mr-1 shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5 group-hover:text-primary" />
              <span className="hidden shrink-0 sm:inline-flex"><VmLogo slug={logoSlug} size={18} /></span>
              <span className="sr-only">Back to </span>
              <span className="min-w-0 truncate">{vmName}</span>
            </Link>
          )}
          {vmStatus && (
            <span className="hidden shrink-0 sm:inline-flex">
              <StatusBadge status={vmStatus} />
            </span>
          )}
        </div>

        <span aria-hidden className="h-5 w-px shrink-0 bg-border" />

        {/* The focused pane's kind. Choosing another starts that kind of session in its place. */}
        <div className="segmented shrink-0" role="group" aria-label="Session type">
          {KIND_ORDER.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => switchKind(k)}
                aria-pressed={activePane.kind === k}
                aria-label={KIND_HINT[k]}
                className="gap-1.5 px-2.5 sm:px-3"
              >
                <Icon aria-hidden size={13} />
                <span aria-hidden className="hidden sm:inline">{KIND_LABEL[k]}</span>
              </button>
            );
          })}
        </div>

        {/* A live region, so a screen reader hears the session connect, drop and come back. */}
        <span role="status" className={cn('sr-only shrink-0 text-[12.5px] font-medium md:not-sr-only md:inline', CONN_TONE[activeConn])}>
          {CONN_LABEL[activeConn]}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {vncHandle && (
            <Menu
              label="Send keys to the display"
              tooltip="Send keys"
              icon={<Keyboard size={15} />}
              items={[
                { label: 'Ctrl+Alt+Delete', onSelect: () => sendCombo('ctrl-alt-del') },
                { label: 'Ctrl+Alt+F1', onSelect: () => sendCombo('ctrl-alt-f1') },
                { label: 'Ctrl+Alt+F2', onSelect: () => sendCombo('ctrl-alt-f2') },
                { label: 'Ctrl+Alt+Backspace', onSelect: () => sendCombo('ctrl-alt-backspace') },
                {
                  label: 'Type the clipboard',
                  hint: 'US layout',
                  onSelect: () => void typeClipboard(),
                  separated: true,
                },
              ]}
            />
          )}
          {vmStatus === 'stopped' && (
            <button
              type="button"
              onClick={() => fire('start', 'Power on')}
              disabled={power.isPending}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-45"
            >
              <Power aria-hidden size={14} />
              Power on
            </button>
          )}
          {(vmStatus === 'running' || vmStatus === 'paused' || vmStatus === 'crashed') && (
            <Menu
              label={`Power: ${vmName}`}
              tooltip="Power"
              icon={<Power size={15} />}
              disabled={power.isPending}
              items={powerItems}
            />
          )}
          <span aria-hidden className="mx-1 h-5 w-px bg-border sm:mx-1.5" />
          <Menu
            label={`Terminal theme: ${THEMES[themeId].name}`}
            tooltip="Terminal theme"
            align="end"
            buttonClassName="w-auto min-w-8 gap-1.5 px-2 text-[12.5px] font-medium"
            trigger={
              <>
                <Palette aria-hidden size={14} />
                <span className="hidden lg:inline">{THEMES[themeId].name}</span>
                <ChevronDown aria-hidden size={13} className="hidden sm:block" />
              </>
            }
            items={THEME_ORDER.map((id) => {
              const p = THEMES[id].palette;
              return {
                key: id,
                label: THEMES[id].name,
                checked: id === themeId,
                hint: (
                  <span aria-hidden className="flex items-center gap-[3px] rounded-[4px] px-[5px] py-[4px] ring-1 ring-inset ring-white/10" style={{ background: p.background }}>
                    {[p.red, p.yellow, p.green, p.blue, p.magenta].map((c, i) => (
                      <span key={i} className="h-2 w-1 rounded-[1px]" style={{ background: c }} />
                    ))}
                  </span>
                ),
                onSelect: () => onThemeChange(id),
              };
            })}
            menuClassName="min-w-[15rem]"
          />
        </div>

        {/* While (re)connecting, an indeterminate bar runs along the header's foot. */}
        {isLive(activeConn) && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden motion-reduce:hidden">
            <div className="h-full w-1/3 animate-[vp-progress_1.4s_ease-in-out_infinite] bg-ring" />
          </div>
        )}
      </header>

      {/* The tab strip, on the canvas: the selected tab takes the terminal's own ground and
          runs into it, the way a desktop terminal's does. */}
      <div className="flex h-10 shrink-0 items-end gap-1 bg-canvas pl-2 pr-1.5 shadow-[inset_0_-1px_0_hsl(var(--border))] sm:pr-4 [@media(pointer:coarse)]:h-11">
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Sessions"
          onKeyDown={onTablistKeyDown}
          onScroll={measureStrip}
          onWheel={(e) => {
            // A mouse wheel scrolls a crowded strip sideways.
            const el = e.currentTarget;
            if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
          }}
          className={cn(
            'flex min-w-0 items-end gap-0.5 overflow-x-auto pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            hidden.start && hidden.end
              ? '[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%_-_24px),transparent)]'
              : hidden.start
                ? '[mask-image:linear-gradient(to_right,transparent,black_24px)]'
                : hidden.end && '[mask-image:linear-gradient(to_left,transparent,black_24px)]',
          )}
        >
          {tabs.map((tab, index) => {
            const selected = tab.id === activeTabId;
            const state = tabState(tab);
            const closable = tabs.length > 1;
            const label = labels.get(tab.id) ?? '';
            const kind = focusedPane(tab).kind;
            const Icon = KIND_ICON[kind];
            const vm = vmById.get(tab.vmId);
            const iconTone =
              state === 'error' ? 'text-red-300' : state === 'closed' || state === 'reconnecting' ? 'text-amber-300' : selected ? 'text-foreground' : 'text-muted-foreground';
            const tabShape = 'relative flex h-8 shrink-0 items-center rounded-t-md [@media(pointer:coarse)]:h-9';
            if (editingTabId === tab.id) {
              return (
                <div key={tab.id} role="presentation" className={cn(tabShape, 'gap-2 px-2.5')} style={{ background: ground }}>
                  <Icon aria-hidden size={14} className={iconTone} />
                  <input
                    autoFocus
                    aria-label="Tab name"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => finishRename(true, false)}
                    onKeyDown={(e) => {
                      // Handled and cancelled here: finishRename puts the cursor back in the
                      // terminal before the browser sends Enter's keypress, which xterm would
                      // pass to the shell.
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        finishRename(true, true);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        finishRename(false, true);
                      }
                    }}
                    className="h-6 w-40 min-w-0 rounded-[4px] border border-ring bg-field px-1.5 text-[13px] font-medium text-foreground outline-none"
                  />
                </div>
              );
            }
            const hint = [
              vm ? `${vm.name} · ${KIND_HINT[kind]}` : KIND_HINT[kind],
              tab.title && tab.title !== label ? tab.title : null,
              'Double-click or F2 to rename',
            ].filter(Boolean).join(' · ');
            return (
              // The tab and its close button sit side by side (a tab can't hold a button).
              // The tab is the one tab stop; Delete closes it from the keyboard, the close
              // button (and a middle click) serve the pointer.
              <div
                key={tab.id}
                role="presentation"
                className={cn(tabShape, 'group/tab', !selected && 'hover:bg-muted/60')}
                style={selected ? { background: ground } : undefined}
                onAuxClick={(e) => {
                  if (e.button === 1 && closable) {
                    e.preventDefault();
                    closeTab(tab.id);
                  }
                }}
              >
                {selected && (
                  // The selected tab's sides and top, so it reads as part of the pane below.
                  <span aria-hidden className="pointer-events-none absolute inset-0 rounded-t-md shadow-[inset_1px_1px_0_hsl(var(--border)),inset_-1px_0_0_hsl(var(--border))]" />
                )}
                <Tooltip label={hint} side="bottom" className="h-full">
                  <button
                    type="button"
                    role="tab"
                    id={`${uid}-tab-${tab.id}`}
                    data-tab-id={tab.id}
                    aria-selected={selected}
                    aria-controls={`${uid}-panel-${tab.id}`}
                    aria-keyshortcuts={closable ? 'F2 Delete' : 'F2'}
                    tabIndex={selected ? 0 : -1}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return;
                      // Select on press without taking focus: the terminal is about to get it.
                      e.preventDefault();
                      selectTab(tab);
                    }}
                    onClick={() => selectTab(tab)}
                    onDoubleClick={() => startRename(tab)}
                    onKeyDown={(e) => onTabKeyDown(e, tab, index)}
                    className={cn(
                      'flex h-full max-w-[220px] select-none items-center gap-2 whitespace-nowrap rounded-t-md pl-2.5 text-[13px] leading-[18px] focus-visible:outline-offset-[-2px]',
                      closable ? 'pr-8' : 'pr-3',
                      selected
                        ? 'font-semibold text-foreground'
                        : tab.activity
                          ? 'font-semibold text-foreground'
                          : 'font-medium text-muted-foreground group-hover/tab:text-foreground',
                    )}
                  >
                    <Icon aria-hidden size={14} className={cn('shrink-0', iconTone)} />
                    <span className="min-w-0 truncate">{label}</span>
                    <span className="sr-only">{`, ${KIND_LABEL[kind]}, ${CONN_LABEL[state]}${tab.activity ? ', new output' : ''}`}</span>
                  </button>
                </Tooltip>
                {closable && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Close ${label}`}
                    title="Close tab"
                    // A press keeps focus where it is: in the terminal.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => closeTab(tab.id)}
                    className={cn(
                      'absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                      'after:absolute after:-inset-1 [@media(pointer:coarse)]:after:-inset-2',
                    )}
                  >
                    <X aria-hidden size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center">
          <Tooltip label={`New tab: ${KIND_PHRASE[activePane.kind]} on ${vmName}`} shortcut={SHORTCUT.newTab}>
            <button
              type="button"
              aria-label="New tab"
              onClick={() => openTab(activeTab.vmId, activePane.kind)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-offset-[-2px] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
            >
              <Plus size={15} />
            </button>
          </Tooltip>
          <Menu
            label="New tab on a VM"
            tooltip="New tab on a VM"
            align="start"
            heading={`Open ${KIND_PHRASE[activePane.kind]} on`}
            icon={<ChevronDown size={15} />}
            buttonClassName="w-6 focus-visible:outline-offset-[-2px] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
            menuClassName="w-64"
            items={
              vms && vms.length > 0
                ? vms.map((vm) => ({
                    key: vm.id,
                    label: vm.name,
                    icon: <StatusGlyph status={vm.status} />,
                    hint: vm.status === 'running' ? undefined : STATUS_WORD[vm.status],
                    onSelect: () => openTab(vm.id, activePane.kind),
                  }))
                : [{ label: vms ? 'No VMs' : 'Loading VMs…', disabled: true, onSelect: () => {} }]
            }
          />
        </div>

        {/* At the pane limit the split buttons stay focusable and say why they do nothing.
            A phone has no room for new splits, but can still close one it was handed. */}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tooltip className="hidden sm:inline-flex" label={splitDisabled ? `Split right (${MAX_PANES} panes is the most a tab holds)` : 'Split right'} shortcut={splitDisabled ? undefined : SHORTCUT.splitRight}>
            <button
              type="button"
              aria-label="Split right"
              aria-disabled={splitDisabled || undefined}
              onClick={() => splitPane('right')}
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-offset-[-2px] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9',
                splitDisabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-muted hover:text-foreground',
              )}
            >
              <Columns2 size={15} />
            </button>
          </Tooltip>
          <Tooltip className="hidden sm:inline-flex" label={splitDisabled ? `Split down (${MAX_PANES} panes is the most a tab holds)` : 'Split down'} shortcut={splitDisabled ? undefined : SHORTCUT.splitDown}>
            <button
              type="button"
              aria-label="Split down"
              aria-disabled={splitDisabled || undefined}
              onClick={() => splitPane('down')}
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-offset-[-2px] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9',
                splitDisabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-muted hover:text-foreground',
              )}
            >
              <Rows2 size={15} />
            </button>
          </Tooltip>
          {/* Touch screens close the focused pane here: a button in each pane's corner
              would sit over its output (with a mouse it shows on hover). */}
          {paneCount(activeTab) > 1 && (
            <Tooltip label="Close pane" className="hidden [@media(pointer:coarse)]:inline-flex">
              <button
                type="button"
                aria-label="Close pane"
                onClick={() => closePane(activeTab, activePane.id)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-offset-[-2px]"
              >
                <X size={15} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* The sessions, on the theme's own ground, so the sliver a fit leaves never shows.
          It is its own stacking layer: the split handles rank among the panes only. */}
      <div className="relative isolate min-h-0 flex-1" style={{ background: ground }}>
        {tabs.map((tab) => {
          const multi = paneCount(tab) > 1;
          const vm = vmById.get(tab.vmId);
          const reachable = reachableOf(vm);
          const stopped = stoppedOf(tab.vmId);
          const showing = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              id={`${uid}-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`${uid}-tab-${tab.id}`}
              className={cn('absolute inset-0 flex flex-col', !showing && 'hidden')}
            >
              {tab.rows.map((row, ri) => (
                <Fragment key={row.id}>
                  {ri > 0 && (
                    <SplitHandle
                      orientation="horizontal"
                      weights={[tab.rowSizes[ri - 1], tab.rowSizes[ri]]}
                      onResize={(first, second) => resizeRows(tab.id, ri - 1, first, second)}
                    />
                  )}
                  <div className="flex min-h-0 min-w-0" style={{ flex: `${tab.rowSizes[ri]} 1 0%` }}>
                    {row.panes.map((pane, ci) => {
                      const active = showing && pane.id === tab.focusPaneId;
                      const common = {
                        reachable,
                        stopped,
                        listAsOf,
                        wakeKey: wake[tab.vmId] ?? 0,
                        active,
                        split: multi,
                        focusKey: focusNonce,
                        onConnState: (s: ConnState) => setPaneConn((prev) => (prev[pane.id] === s ? prev : { ...prev, [pane.id]: s })),
                        onAction: onPaneAction,
                      };
                      return (
                        <Fragment key={pane.id}>
                          {ci > 0 && (
                            <SplitHandle
                              orientation="vertical"
                              weights={[row.sizes[ci - 1], row.sizes[ci]]}
                              onResize={(first, second) => resizePanes(tab.id, row.id, ci - 1, first, second)}
                            />
                          )}
                          <div
                            onMouseDown={() => setFocusPane(tab.id, pane.id)}
                            onFocusCapture={() => setFocusPane(tab.id, pane.id)}
                            className="group/pane relative isolate flex min-h-0 min-w-0"
                            style={{ flex: `${row.sizes[ci]} 1 0%` }}
                          >
                            {pane.kind === 'vnc' ? (
                              <VncPane
                                {...common}
                                vmId={tab.vmId}
                                ground={ground}
                                onHandle={(h) => {
                                  if (h) vncHandles.current.set(pane.id, h);
                                  else vncHandles.current.delete(pane.id);
                                }}
                              />
                            ) : (
                              <TerminalPane
                                {...common}
                                down={downOf(tab.vmId)}
                                vmId={tab.vmId}
                                kind={pane.kind}
                                themeId={themeId}
                                onTitle={(t) => handleTitle(pane.id, t)}
                                onOutput={() => markActivity(tab.id)}
                              />
                            )}
                            {/* The focused pane of a split: a steel edge, drawn over the output. */}
                            {multi && pane.id === tab.focusPaneId && (
                              <div aria-hidden className="pointer-events-none absolute inset-0 z-10 shadow-[inset_0_0_0_1px_hsl(var(--ring)/0.7)]" />
                            )}
                            {multi && (
                              <Tooltip
                                label="Close pane"
                                className="absolute right-1.5 top-1.5 z-20 opacity-0 transition-opacity duration-100 focus-within:opacity-100 group-hover/pane:opacity-100 [@media(pointer:coarse)]:hidden"
                              >
                                <button
                                  type="button"
                                  aria-label={`Close ${KIND_LABEL[pane.kind]} pane`}
                                  onClick={() => closePane(tab, pane.id)}
                                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-pop transition-colors hover:text-foreground"
                                >
                                  <X size={14} />
                                </button>
                              </Tooltip>
                            )}
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                </Fragment>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
