import { useCallback, useEffect, useRef, useState, type ReactNode, type ComponentType, type RefObject } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  ArchiveIcon,
  ChevronLeft,
  ChevronRight,
  Database,
  Disc,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LogOut,
  type LucideProps,
  Menu as MenuIcon,
  Moon,
  Network,
  Plus,
  ScrollText,
  Server,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { StatusGlyph } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { useVms } from '@/hooks/useVms';
import { useAuthStore } from '@/store/authStore';
import { useThemeStore } from '@/store/themeStore';
import { useHostName } from '@/hooks/useSystemStats';

// The version the operator sees. scripts/check-versions.sh checks this literal, and the
// login screen imports it so the two can never disagree again.
export const APP_VERSION = 'v2.14.0';

interface LayoutProps {
  children?: ReactNode;
  actions?: ReactNode;
  title?: string;
  subtitle?: string;
  /** The browser-tab title, for pages that draw their own header (a VM's name…). */
  docTitle?: string;
}

const SIDEBAR_KEY = 'virtpilotSidebarCollapsed';

// One column for the page: the header's title and actions line up with the panels below.
const PAGE_COLUMN = 'mx-auto max-w-6xl px-4 sm:px-6 lg:px-8';

// "[" toggles the sidebar, as in most tools that have one — unless the key is meant for
// something else: a field, an editor, the console terminal, or an open dialog.
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable="true"], .xterm');
}

export function Layout({ children, actions, title, subtitle, docTitle }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === 'true');
  // Phones: the sidebar is a drawer behind the top bar's menu button.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  const toggle = useCallback(
    () =>
      setCollapsed((v) => {
        localStorage.setItem(SIDEBAR_KEY, String(!v));
        return !v;
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isTypingTarget(e.target) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  // Each tab says which page, on which host: "Virtual machines · db-host · VirtPilot".
  const host = useHostName();
  const page = docTitle ?? title;
  useEffect(() => {
    document.title = [page, host, 'VirtPilot'].filter(Boolean).join(' · ');
  }, [page, host]);

  // The frame: navigation sits on the canvas, and each page is a sheet inset on it.
  // The sidebar's own control lives on the seam between the two, not beside the logo.
  // Below 768px there is no room for a sidebar: a top bar on the canvas carries the logo
  // and a menu button, the sidebar becomes a drawer, and the sheet runs edge to edge.
  return (
    <div className="app-frame flex flex-col bg-canvas text-foreground md:flex-row">
      <TopBar open={drawerOpen} onOpen={() => setDrawerOpen(true)} buttonRef={menuButtonRef} />
      {drawerOpen && <NavDrawer onClose={closeDrawer} />}

      <div className="group/nav relative hidden shrink-0 md:flex">
        <Sidebar collapsed={collapsed} />
        <SidebarHandle collapsed={collapsed} onToggle={toggle} />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-sheet-border bg-background md:rounded-[12px] md:border md:shadow-sheet">
          {(title || actions) && (
            <header className="shrink-0 overflow-hidden border-b border-border pb-4 pt-5 [scrollbar-gutter:stable] sm:pb-5 sm:pt-6">
              <div className={PAGE_COLUMN}>
                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                  <div className="min-w-0 flex-[1_1_22rem]">
                    {title && (
                      <h1 className="text-[26px] font-semibold leading-8 tracking-[-0.024em] text-foreground">{title}</h1>
                    )}
                    {subtitle && (
                      <p className="mt-1 text-[13.5px] text-muted-foreground">{subtitle}</p>
                    )}
                  </div>
                  {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
                </div>
              </div>
            </header>
          )}
          {/* Both reserve the same scrollbar gutter, so a classic (non-overlay) scrollbar
              can't pull the content out of line with the title. */}
          <main className="flex-1 overflow-auto [scrollbar-gutter:stable]">
            <div className={cn(PAGE_COLUMN, 'py-5 sm:py-7')}>
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// ─── Phones: top bar and drawer ───────────────────────────────────────────────
//
// The same logo the sidebar shows, on the same canvas, and one button for the
// navigation. The drawer is the sidebar itself, so nothing about it is learnt twice.

function TopBar({ open, onOpen, buttonRef }: { open: boolean; onOpen: () => void; buttonRef: RefObject<HTMLButtonElement> }) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between pl-3 pr-2 md:hidden">
      <Link to="/" aria-label="VirtPilot - Dashboard" className="flex h-10 items-center rounded-md px-[7px] focus-visible:outline-offset-0">
        <img src="/brand/virtpilot-horizontal.svg" alt="" className="h-[26px] w-[83px] max-w-none dark:hidden" />
        <img src="/brand/virtpilot-horizontal-dark.svg" alt="" className="hidden h-[26px] w-[83px] max-w-none dark:block" />
      </Link>
      <button
        ref={buttonRef}
        type="button"
        onClick={onOpen}
        aria-label="Open navigation"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <MenuIcon className="h-5 w-5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

// A modal drawer: focus moves in and stays in, Escape or the backdrop closes it (and
// focus returns to the menu button), as does following a link or growing the window
// past the phone breakpoint, where the real sidebar takes over.
function NavDrawer({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('[data-drawer-close]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !panel) return;
      const stops = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'));
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      // Focus can drop to <body> (a click on the drawer's plain text): Tab comes back in.
      if (!panel.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    const wide = window.matchMedia('(min-width: 768px)');
    const onWide = () => { if (wide.matches) closeRef.current(); };
    document.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWide);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <div role="dialog" aria-modal="true" aria-label="Navigation" className="fixed inset-0 z-50 md:hidden">
      <div aria-hidden className="absolute inset-0 animate-fade-in bg-[#1B2433]/40 dark:bg-black/70" onClick={onClose} />
      <div ref={panelRef} className="nav-drawer-panel absolute inset-y-0 left-0 flex bg-canvas shadow-pop">
        <button
          data-drawer-close
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute right-2 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <X className="h-5 w-5" strokeWidth={1.75} />
        </button>
        <Sidebar collapsed={false} onNavigate={onClose} />
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
//
// One set of markup for both widths, so collapsing is a single motion: the width
// shrinks, labels fade, the wordmark is clipped back into its mark — and the icons
// never move. Group labels fade to a short rule of the same height for the same reason.

const ICON = 'h-4 w-4 shrink-0 transition-colors';
const FADE = 'transition-opacity duration-150 motion-reduce:transition-none';

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const { theme, toggle: toggleTheme } = useThemeStore();

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <aside
      className={cn(
        'flex flex-col overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-[64px]' : 'w-[236px]'
      )}
    >
      {/* Brand — the way home, nothing else */}
      <div className="flex h-[72px] shrink-0 items-center px-3">
        <Link
          to="/"
          aria-label="VirtPilot - Dashboard"
          onClick={onNavigate}
          className="flex h-10 items-center rounded-md px-[7px] focus-visible:outline-offset-0"
        >
          <span
            className={cn(
              'block h-[26px] overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none',
              collapsed ? 'w-[26px]' : 'w-[83px]'
            )}
          >
            <img src="/brand/virtpilot-horizontal.svg" alt="" className="h-[26px] w-[83px] max-w-none dark:hidden" />
            <img src="/brand/virtpilot-horizontal-dark.svg" alt="" className="hidden h-[26px] w-[83px] max-w-none dark:block" />
          </span>
        </Link>
      </div>

      {/* Navigation */}
      <nav aria-label="Main" className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-1">
        <NavGroup label="Compute" collapsed={collapsed} first>
          <NavItem to="/" label="Dashboard" onNavigate={onNavigate} icon={LayoutDashboard} end collapsed={collapsed} />
          <NavItem to="/vms/new" label="New VM" onNavigate={onNavigate} icon={Plus} collapsed={collapsed} />
        </NavGroup>
        <NavGroup label="Resources" collapsed={collapsed}>
          <NavItem to="/vms" label="Virtual machines" onNavigate={onNavigate} icon={Server} collapsed={collapsed} badge={<RunningVmsBadge />} dot={<RunningVmsDot />} />
          <NavItem to="/networks" label="Networks" onNavigate={onNavigate} icon={Network} collapsed={collapsed} />
          <NavItem to="/templates" label="Templates" onNavigate={onNavigate} icon={HardDrive} collapsed={collapsed} />
          <NavItem to="/isos" label="ISOs" onNavigate={onNavigate} icon={Disc} collapsed={collapsed} />
          <NavItem to="/storage" label="Storage" onNavigate={onNavigate} icon={Database} collapsed={collapsed} />
          <NavItem to="/backups" label="Backups" onNavigate={onNavigate} icon={ArchiveIcon} collapsed={collapsed} />
        </NavGroup>
        <NavGroup label="System" collapsed={collapsed}>
          <NavItem to="/ssh-keys" label="SSH keys" onNavigate={onNavigate} icon={KeyRound} collapsed={collapsed} />
          <NavItem to="/logs" label="Logs" onNavigate={onNavigate} icon={ScrollText} collapsed={collapsed} />
          <NavItem to="/settings" label="Settings" onNavigate={onNavigate} icon={Settings2} collapsed={collapsed} />
        </NavGroup>
      </nav>

      {/* Footer — session controls, styled as the items above so they align with them */}
      <div className="shrink-0 space-y-px px-3 pb-3 pt-2">
        <FooterItem
          icon={theme === 'dark' ? Sun : Moon}
          label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={toggleTheme}
          collapsed={collapsed}
        />
        <FooterItem icon={LogOut} label="Sign out" onClick={handleLogout} collapsed={collapsed} />
        <p className={cn('truncate px-3 pt-2 font-mono text-[11px] text-muted-foreground', FADE, collapsed && 'opacity-0')}>
          VirtPilot {APP_VERSION}
        </p>
      </div>
    </aside>
  );
}

// The sidebar's control: a small round handle on the seam. It shows while the pointer
// is over the sidebar (always on touch screens, and whenever it has keyboard focus),
// and stays visible once collapsed — the way back must never be hidden.
function SidebarHandle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <div className="absolute -right-3 top-1/2 z-20 -translate-y-1/2">
      <Tooltip label={label} shortcut="[" side="right">
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          aria-expanded={!collapsed}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full border border-sheet-border bg-card text-muted-foreground',
            'shadow-[0_1px_3px_rgb(27_36_51/0.12)] dark:shadow-[0_1px_3px_rgb(0_0_0/0.55)]',
            'transition-[opacity,color,border-color] duration-150 hover:border-input hover:text-foreground focus-visible:opacity-100',
            collapsed ? 'opacity-100' : 'opacity-0 group-hover/nav:opacity-100 [@media(hover:none)]:opacity-100'
          )}
        >
          {collapsed ? <ChevronRight size={14} strokeWidth={2} /> : <ChevronLeft size={14} strokeWidth={2} />}
        </button>
      </Tooltip>
    </div>
  );
}

// ─── Nav helpers ──────────────────────────────────────────────────────────────

function NavGroup({ label, collapsed, first, children }: { label: string; collapsed: boolean; first?: boolean; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="relative mb-1 h-5" aria-hidden={collapsed}>
        <p className={cn('absolute inset-0 truncate px-3 text-[11.5px] font-medium leading-5 text-muted-foreground', FADE, collapsed && 'opacity-0')}>
          {label}
        </p>
        {!first && (
          <span className={cn('absolute left-3 top-1/2 h-px w-4 bg-input', FADE, collapsed ? 'opacity-100' : 'opacity-0')} />
        )}
      </div>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

// The active page is lifted onto the sheet's own white, with its icon in steel.
const navActive = 'bg-[hsl(var(--nav-active))] font-medium text-foreground shadow-nav [&>svg]:text-[#3B6797] dark:[&>svg]:text-[#86AEDA]';
const navIdle = 'text-[#3A4556] hover:bg-foreground/[0.05] hover:text-foreground dark:text-[#A9B2BF] [&>svg]:text-muted-foreground hover:[&>svg]:text-foreground';
const navItem = 'relative flex h-9 w-full items-center gap-3 overflow-hidden rounded-md px-3 text-[13.5px] transition-colors duration-150';

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  badge,
  dot,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: ComponentType<LucideProps>;
  end?: boolean;
  badge?: ReactNode;
  dot?: ReactNode;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Tooltip label={label} side="right" disabled={!collapsed} className="flex w-full">
      <NavLink to={to} end={end} onClick={onNavigate} className={({ isActive }) => cn(navItem, isActive ? navActive : navIdle)}>
        <Icon className={ICON} strokeWidth={1.75} />
        <span className={cn('whitespace-nowrap', FADE, collapsed && 'opacity-0')}>{label}</span>
        {badge && <span className={cn('ml-auto', FADE, collapsed && 'opacity-0')}>{badge}</span>}
        {dot && <span className={cn('absolute left-[25px] top-[8px]', FADE, collapsed ? 'opacity-100' : 'opacity-0')}>{dot}</span>}
      </NavLink>
    </Tooltip>
  );
}

function FooterItem({
  icon: Icon,
  label,
  onClick,
  collapsed,
}: {
  icon: ComponentType<LucideProps>;
  label: string;
  onClick: () => void;
  collapsed: boolean;
}) {
  return (
    <Tooltip label={label} side="right" disabled={!collapsed} className="flex w-full">
      <button type="button" onClick={onClick} className={cn(navItem, navIdle)}>
        <Icon className={ICON} strokeWidth={1.75} />
        <span className={cn('whitespace-nowrap', FADE, collapsed && 'opacity-0')}>{label}</span>
      </button>
    </Tooltip>
  );
}

// ─── Badges & status ──────────────────────────────────────────────────────────

function RunningVmsBadge() {
  const { data: vms } = useVms();
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  if (!running) return null;
  return (
    <span className="flex items-center gap-1.5 text-[12px] tabular-nums text-muted-foreground" title={`${running} running`}>
      <StatusGlyph status="running" size={6} />
      {running}
    </span>
  );
}

function RunningVmsDot() {
  const { data: vms } = useVms();
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  if (!running) return null;
  return <StatusGlyph status="running" size={6} />;
}
