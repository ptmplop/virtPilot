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
import { cn } from '@/lib/cn';
import { useVms } from '@/hooks/useVms';
import { useAuthStore } from '@/store/authStore';

// The version the operator sees. scripts/check-versions.sh checks this literal, and the
// login screen imports it so the two can never disagree again.
export const APP_VERSION = 'v2.10.0';

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

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar collapsed={collapsed} onToggle={toggle} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {(title || actions) && (
          <header className="shrink-0 border-b border-border bg-background px-6 pb-5 pt-7">
            <div className="mx-auto max-w-6xl lg:px-2">
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  {title && (
                    <h1 className="text-[22px] font-semibold leading-7 tracking-[-0.015em] text-foreground">{title}</h1>
                  )}
                  {subtitle && (
                    <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
                  )}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
              </div>
            </div>
          </header>
        )}
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-6xl px-6 py-8 lg:px-8">
            {children}
          </div>
        </main>
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

  return (
    <aside
      className={cn(
        'dark flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-[#A3ADBC] transition-[width] duration-200 ease-out',
        collapsed ? 'w-[60px]' : 'w-[232px]'
      )}
    >
      {/* Brand */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 pb-2 pt-4">
          <img src="/brand/virtpilot-symbol-small-dark.svg" alt="VirtPilot" className="h-7 w-7" />
          <Tooltip label="Expand sidebar" side="right">
            <button
              type="button"
              onClick={onToggle}
              aria-label="Expand sidebar"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[#7F8A9B] transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
            >
              <PanelLeftOpen size={13} />
            </button>
          </Tooltip>
        </div>
      ) : (
        <div className="flex h-[68px] items-center gap-2 pl-5 pr-3">
          <img src="/brand/virtpilot-horizontal-dark.svg" alt="VirtPilot" className="h-[26px] w-auto" />
          <Tooltip label="Collapse sidebar" side="right">
            <button
              type="button"
              onClick={onToggle}
              aria-label="Collapse sidebar"
              className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#7F8A9B] transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
            >
              <PanelLeftClose size={14} />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Navigation */}
      <nav className={cn('flex-1 overflow-y-auto pb-3 pt-1', collapsed ? 'px-2.5' : 'px-3')}>
        {collapsed ? (
          <div className="space-y-0.5">
            <CollapsedNavItem to="/" icon={LayoutDashboard} label="Dashboard" end />
            <CollapsedNavItem to="/vms/new" icon={Plus} label="New VM" />
            <div className="mx-2 my-2.5 border-t border-sidebar-border" />
            <CollapsedNavItem to="/vms" icon={Server} label="Virtual Machines" badge={<RunningVmsDot />} />
            <CollapsedNavItem to="/networks" icon={Network} label="Networks" />
            <CollapsedNavItem to="/templates" icon={HardDrive} label="Templates" />
            <CollapsedNavItem to="/isos" icon={Disc} label="ISOs" />
            <CollapsedNavItem to="/storage" icon={Database} label="Storage" />
            <CollapsedNavItem to="/backups" icon={ArchiveIcon} label="Backups" />
            <div className="mx-2 my-2.5 border-t border-sidebar-border" />
            <CollapsedNavItem to="/ssh-keys" icon={KeyRound} label="SSH Keys" />
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
              <NavItem to="/vms" label="Virtual Machines" icon={Server} badge={<RunningVmsBadge />} />
              <NavItem to="/networks" label="Networks" icon={Network} />
              <NavItem to="/templates" label="Templates" icon={HardDrive} />
              <NavItem to="/isos" label="ISOs" icon={Disc} />
              <NavItem to="/storage" label="Storage" icon={Database} />
              <NavItem to="/backups" label="Backups" icon={ArchiveIcon} />
            </NavSection>
            <NavSection label="System">
              <NavItem to="/ssh-keys" label="SSH Keys" icon={KeyRound} />
              <NavItem to="/logs" label="Logs" icon={ScrollText} />
              <NavItem to="/settings" label="Settings" icon={Settings2} />
            </NavSection>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className={cn('border-t border-sidebar-border py-2.5', collapsed ? 'px-2.5' : 'px-3')}>
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <ThemeToggle />
            <Tooltip label="Sign out" side="right">
              <button
                type="button"
                onClick={handleLogout}
                aria-label="Sign out"
                className="flex h-8 w-8 items-center justify-center rounded-md text-[#7F8A9B] transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
              >
                <LogOut size={13} />
              </button>
            </Tooltip>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleLogout}
              className="flex flex-1 items-center gap-3 rounded-md px-2.5 py-2 text-[13px] text-[#A3ADBC] transition-colors duration-150 hover:bg-white/[0.06] hover:text-white"
            >
              <LogOut size={15} strokeWidth={1.75} />
              <span>Sign out</span>
            </button>
            <ThemeToggle />
          </div>
        )}
        {!collapsed && (
          <p className="mt-1.5 px-2.5 font-mono text-[10.5px] text-[#5F6A7B]">VirtPilot {APP_VERSION}</p>
        )}
      </div>
    </aside>
  );
}

// ─── Nav helpers ──────────────────────────────────────────────────────────────

function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <p className="mb-1.5 px-2.5 text-[11px] font-medium text-[#6B7687]">{label}</p>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

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
          'relative flex items-center gap-3 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors duration-150',
          isActive
            ? 'bg-white/[0.07] font-medium text-white before:absolute before:-left-3 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-[#86AEDA]'
            : 'text-[#A3ADBC] hover:bg-white/[0.04] hover:text-white'
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
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
        className={({ isActive }) =>
          cn(
            'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors duration-150',
            isActive
              ? 'bg-white/[0.08] text-white'
              : 'text-[#A3ADBC] hover:bg-white/[0.05] hover:text-white'
          )
        }
      >
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        {badge && <span className="absolute right-0.5 top-0.5">{badge}</span>}
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
    <span className="ml-auto font-mono text-[11px] tabular-nums text-emerald-300" title={`${running} running`}>
      {running}
    </span>
  );
}

function RunningVmsDot() {
  const { data: vms } = useVms();
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  if (!running) return null;
  return (
    <span className="block h-1.5 w-1.5 rounded-full bg-emerald-300" />
  );
}
