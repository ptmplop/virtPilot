import { useState, type ReactNode, type ComponentType } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Cpu,
  Database,
  Disc,
  HardDrive,
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
          <header className="shrink-0 border-b border-border/60 bg-card/40 px-6 py-6 backdrop-blur-sm">
            <div className="mx-auto max-w-6xl lg:px-2">
              <div className="flex items-center justify-between gap-4">
                <div>
                  {title && (
                    <h1 className="text-xl font-bold tracking-tight text-foreground">{title}</h1>
                  )}
                  {subtitle && (
                    <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
                  )}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
              </div>
            </div>
          </header>
        )}
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-6xl px-6 py-8 lg:px-8 animate-slide-up">
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
        'dark flex shrink-0 flex-col border-r border-sidebar-border overflow-hidden transition-[max-width] duration-200',
        collapsed ? 'max-w-[56px]' : 'max-w-[320px]'
      )}
      style={{
        background: 'linear-gradient(170deg, hsl(224 30% 7%) 0%, hsl(222 28% 4%) 100%)',
      }}
    >
      {/* Brand */}
      <div className={cn('flex items-center gap-3 pb-4 pt-5', collapsed ? 'justify-center px-0' : 'px-5')}>
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-primary/25"
          style={{ background: 'linear-gradient(135deg, hsl(214 100% 62% / 0.3), hsl(214 100% 62% / 0.08))' }}
        >
          <Cpu size={15} className="text-primary" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="block text-sm font-bold tracking-tight text-white">VirtPilot</span>
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-white/30">
              KVM Manager
            </p>
          </div>
        )}
      </div>

      <div className="mx-4 h-px bg-gradient-to-r from-transparent via-white/8 to-transparent" />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4" style={{ padding: collapsed ? '16px 8px' : '16px 12px' }}>
        {collapsed ? (
          <div className="space-y-1">
            <CollapsedNavItem to="/" icon={LayoutDashboard} label="Dashboard" end />
            <CollapsedNavItem to="/vms/new" icon={Plus} label="New VM" />
            <div className="my-3 h-px bg-white/6" />
            <CollapsedNavItem to="/vms" icon={Server} label="Virtual Machines" badge={<RunningVmsDot />} />
            <CollapsedNavItem to="/networks" icon={Network} label="Networks" />
            <CollapsedNavItem to="/templates" icon={HardDrive} label="Templates" />
            <CollapsedNavItem to="/isos" icon={Disc} label="ISOs" />
            <CollapsedNavItem to="/storage" icon={Database} label="Storage" />
            <div className="my-3 h-px bg-white/6" />
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
            </NavSection>
            <NavSection label="System">
              <NavItem to="/logs" label="Logs" icon={ScrollText} />
              <NavItem to="/settings" label="Settings" icon={Settings2} />
            </NavSection>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className={cn('pb-4 pt-2', collapsed ? 'px-2' : 'px-4')}>
        <div className="mb-3 h-px bg-gradient-to-r from-transparent via-white/8 to-transparent" />

        {collapsed ? (
          <div className="flex flex-col items-center gap-3">
            <ThemeToggle />
            <Tooltip label="Sign out" side="right">
              <button
                type="button"
                onClick={handleLogout}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-white/30 transition-all hover:bg-white/6 hover:text-red-400"
              >
                <LogOut size={13} />
              </button>
            </Tooltip>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <span className="ml-auto font-mono text-[10px] text-white/45">v1.0.5</span>
            <Tooltip label="Sign out" side="top">
              <button
                type="button"
                onClick={handleLogout}
                className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg text-white/25 transition-all hover:bg-white/6 hover:text-red-400"
              >
                <LogOut size={13} />
              </button>
            </Tooltip>
          </div>
        )}

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'mt-3 flex w-full items-center rounded-lg px-2 py-1.5 text-white/25 transition-all hover:bg-white/5 hover:text-white/50',
            collapsed ? 'justify-center' : 'gap-2'
          )}
        >
          {collapsed
            ? <PanelLeftOpen size={14} />
            : (
              <>
                <PanelLeftClose size={14} />
                <span className="text-[11px]">Collapse</span>
              </>
            )}
        </button>
      </div>
    </aside>
  );
}

// ─── Nav helpers ──────────────────────────────────────────────────────────────

function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <p className="mb-1.5 px-3 text-[9px] font-bold uppercase tracking-[0.14em] text-white/25">
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
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
          'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
          isActive
            ? 'bg-primary/12 text-primary ring-1 ring-primary/15'
            : 'text-white/45 hover:bg-white/6 hover:text-white/80'
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn(
              'h-4 w-4 shrink-0 transition-colors',
              isActive ? 'text-primary' : 'text-white/35 group-hover:text-white/60'
            )}
          />
          <span className="whitespace-nowrap">{label}</span>
          {badge}
        </>
      )}
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
            'relative flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-150',
            isActive
              ? 'bg-primary/15 text-primary ring-1 ring-primary/20'
              : 'text-white/35 hover:bg-white/6 hover:text-white/70'
          )
        }
      >
        <Icon className="h-4 w-4 shrink-0" />
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
    <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400 ring-1 ring-emerald-500/20">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      {running}
    </span>
  );
}

function RunningVmsDot() {
  const { data: vms } = useVms();
  const running = vms?.filter((v) => v.status === 'running').length ?? 0;
  if (!running) return null;
  return (
    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_1px_rgb(52_211_153_/_0.6)]" />
  );
}

