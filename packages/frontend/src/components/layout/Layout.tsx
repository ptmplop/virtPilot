import { useState, type ReactNode, type ComponentType } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  ArchiveIcon,
  Database,
  Disc,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LogOut,
  type LucideProps,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
  Server,
  Settings2,
} from 'lucide-react';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { Tooltip } from '@/components/ui/Tooltip';
import { StatusGlyph } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { useVms } from '@/hooks/useVms';
import { useAuthStore } from '@/store/authStore';

// The version the operator sees. scripts/check-versions.sh checks this literal, and the
// login screen imports it so the two can never disagree again.
export const APP_VERSION = 'v2.11.0';

interface LayoutProps {
  children?: ReactNode;
  actions?: ReactNode;
  title?: string;
  subtitle?: string;
}

export function Layout({ children, actions, title, subtitle }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('virtpilotSidebarCollapsed') === 'true'
  );

  const toggle = () =>
    setCollapsed((v) => {
      localStorage.setItem('virtpilotSidebarCollapsed', String(!v));
      return !v;
    });

  // The frame: navigation sits on the canvas, and each page is a sheet inset on it.
  return (
    <div className="flex h-screen bg-canvas text-foreground">
      <Sidebar collapsed={collapsed} onToggle={toggle} />

      <div className="flex min-w-0 flex-1 flex-col py-2 pr-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-sheet-border bg-background shadow-sheet">
          {(title || actions) && (
            <header className="shrink-0 border-b border-border px-6 pb-5 pt-6">
              <div className="mx-auto max-w-6xl lg:px-2">
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
          <main className="flex-1 overflow-auto">
            <div className="mx-auto max-w-6xl px-6 py-7 lg:px-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  const quiet =
    'flex items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground';

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out',
        collapsed ? 'w-[64px]' : 'w-[236px]'
      )}
    >
      {/* Brand */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 pb-2 pt-[18px]">
          <img src="/brand/virtpilot-symbol-small.svg" alt="VirtPilot" className="h-7 w-7 dark:hidden" />
          <img src="/brand/virtpilot-symbol-small-dark.svg" alt="VirtPilot" className="hidden h-7 w-7 dark:block" />
          <Tooltip label="Expand sidebar" side="right">
            <button type="button" onClick={onToggle} aria-label="Expand sidebar" className={cn(quiet, 'h-7 w-7')}>
              <PanelLeftOpen size={14} strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      ) : (
        <div className="flex h-[72px] items-center gap-2 pl-[22px] pr-3">
          <img src="/brand/virtpilot-horizontal.svg" alt="VirtPilot" className="h-[26px] w-auto dark:hidden" />
          <img src="/brand/virtpilot-horizontal-dark.svg" alt="VirtPilot" className="hidden h-[26px] w-auto dark:block" />
          <Tooltip label="Collapse sidebar" side="right">
            <button type="button" onClick={onToggle} aria-label="Collapse sidebar" className={cn(quiet, 'ml-auto h-7 w-7 shrink-0')}>
              <PanelLeftClose size={14} strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Navigation */}
      <nav aria-label="Main" className={cn('flex-1 overflow-y-auto pb-3 pt-1', collapsed ? 'px-3' : 'px-3')}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <CollapsedNavItem to="/" icon={LayoutDashboard} label="Dashboard" end />
            <CollapsedNavItem to="/vms/new" icon={Plus} label="New VM" />
            <div className="my-2 w-6 border-t border-sheet-border" />
            <CollapsedNavItem to="/vms" icon={Server} label="Virtual machines" badge={<RunningVmsDot />} />
            <CollapsedNavItem to="/networks" icon={Network} label="Networks" />
            <CollapsedNavItem to="/templates" icon={HardDrive} label="Templates" />
            <CollapsedNavItem to="/isos" icon={Disc} label="ISOs" />
            <CollapsedNavItem to="/storage" icon={Database} label="Storage" />
            <CollapsedNavItem to="/backups" icon={ArchiveIcon} label="Backups" />
            <div className="my-2 w-6 border-t border-sheet-border" />
            <CollapsedNavItem to="/ssh-keys" icon={KeyRound} label="SSH keys" />
            <CollapsedNavItem to="/logs" icon={ScrollText} label="Logs" />
            <CollapsedNavItem to="/settings" icon={Settings2} label="Settings" />
          </div>
        ) : (
          <>
            <NavSection label="Compute">
              <NavItem to="/" label="Dashboard" icon={LayoutDashboard} end />
              <NavItem to="/vms/new" label="New VM" icon={Plus} />
            </NavSection>
            <NavSection label="Resources">
              <NavItem to="/vms" label="Virtual machines" icon={Server} badge={<RunningVmsBadge />} />
              <NavItem to="/networks" label="Networks" icon={Network} />
              <NavItem to="/templates" label="Templates" icon={HardDrive} />
              <NavItem to="/isos" label="ISOs" icon={Disc} />
              <NavItem to="/storage" label="Storage" icon={Database} />
              <NavItem to="/backups" label="Backups" icon={ArchiveIcon} />
            </NavSection>
            <NavSection label="System">
              <NavItem to="/ssh-keys" label="SSH keys" icon={KeyRound} />
              <NavItem to="/logs" label="Logs" icon={ScrollText} />
              <NavItem to="/settings" label="Settings" icon={Settings2} />
            </NavSection>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className={cn('pb-3 pt-2', collapsed ? 'px-3' : 'px-3')}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <ThemeToggle />
            <Tooltip label="Sign out" side="right">
              <button type="button" onClick={handleLogout} aria-label="Sign out" className={cn(quiet, 'h-8 w-8')}>
                <LogOut size={14} strokeWidth={1.75} />
              </button>
            </Tooltip>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleLogout}
                className="flex flex-1 items-center gap-3 rounded-md px-2.5 py-[7px] text-[13.5px] text-[#3A4556] transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground dark:text-[#A9B2BF]"
              >
                <LogOut size={16} strokeWidth={1.75} className="text-muted-foreground" />
                <span>Sign out</span>
              </button>
              <ThemeToggle />
            </div>
            <p className="mt-2 px-2.5 font-mono text-[11px] text-muted-foreground">VirtPilot {APP_VERSION}</p>
          </>
        )}
      </div>
    </aside>
  );
}

// ─── Nav helpers ──────────────────────────────────────────────────────────────

function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <p className="mb-1 px-2.5 text-[11.5px] font-medium text-muted-foreground">{label}</p>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

// The active page is lifted onto the sheet's own white, with its icon in steel.
const navActive = 'bg-[hsl(var(--nav-active))] font-medium text-foreground shadow-nav [&>svg]:text-[#3B6797] dark:[&>svg]:text-[#86AEDA]';
const navIdle = 'text-[#3A4556] hover:bg-foreground/[0.05] hover:text-foreground dark:text-[#A9B2BF] [&>svg]:text-muted-foreground hover:[&>svg]:text-foreground';

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  badge,
}: {
  to: string;
  label: string;
  icon: ComponentType<LucideProps>;
  end?: boolean;
  badge?: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors duration-150',
          isActive ? navActive : navIdle
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0 transition-colors" strokeWidth={1.75} />
      <span className="whitespace-nowrap">{label}</span>
      {badge}
    </NavLink>
  );
}

function CollapsedNavItem({
  to,
  icon: Icon,
  label,
  end,
  badge,
}: {
  to: string;
  icon: ComponentType<LucideProps>;
  label: string;
  end?: boolean;
  badge?: ReactNode;
}) {
  return (
    <Tooltip label={label} side="right">
      <NavLink
        to={to}
        end={end}
        aria-label={label}
        className={({ isActive }) =>
          cn(
            'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-150',
            isActive ? navActive : navIdle
          )
        }
      >
        <Icon className="h-4 w-4 shrink-0 transition-colors" strokeWidth={1.75} />
        {badge && <span className="absolute right-1 top-1">{badge}</span>}
      </NavLink>
    </Tooltip>
  );
}

// ─── Badges & status ──────────────────────────────────────────────────────────

function RunningVmsBadge() {
  const { data: vms } = useVms();
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  if (!running) return null;
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[12px] tabular-nums text-muted-foreground" title={`${running} running`}>
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
