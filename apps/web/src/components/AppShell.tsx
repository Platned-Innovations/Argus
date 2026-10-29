import { type Permission, ROLE_LABELS } from '@argus/shared';
import { BellRing, Bot, Bug, FileBarChart, FolderGit2, PackageSearch, Plug, ShieldOff, SlidersHorizontal, LayoutDashboard, LogOut, Menu, Radar, ScrollText, Settings2, ShieldAlert, UserCircle, Users, UsersRound, X } from 'lucide-react';
import { type ComponentType, type ReactNode, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  permission?: Permission;
  soon?: boolean;
}

const sections: { title?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    title: 'Security',
    items: [
      { to: '/findings', label: 'Findings', icon: Bug, permission: 'findings:read' },
      { to: '/repositories', label: 'Repositories', icon: FolderGit2, permission: 'repos:read' },
      { to: '/packages', label: 'Package search', icon: PackageSearch, permission: 'repos:read' },
      { to: '/suppressions', label: 'Suppressions', icon: ShieldOff, permission: 'findings:read' },
      { to: '/tickets', label: 'Tickets', icon: ShieldAlert, permission: 'tickets:read' },
      { to: '/reports', label: 'Reports', icon: FileBarChart, permission: 'reports:read' },
      { to: '/intel', label: 'Threat intel', icon: Radar, permission: 'findings:read' },
    ],
  },
  {
    title: 'Administration',
    items: [
      { to: '/admin/sources', label: 'Sources', icon: Plug, permission: 'sources:manage' },
      { to: '/admin/integrations', label: 'Integrations', icon: BellRing, permission: 'settings:manage' },
      { to: '/admin/ai', label: 'AI assistance', icon: Bot, permission: 'settings:manage' },
      { to: '/admin/users', label: 'Users', icon: Users, permission: 'users:read' },
      { to: '/admin/teams', label: 'Teams', icon: UsersRound, permission: 'teams:read' },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText, permission: 'audit:read' },
      { to: '/admin/scanning', label: 'Scanning settings', icon: SlidersHorizontal, permission: 'settings:read' },
      { to: '/admin/security', label: 'Security settings', icon: Settings2, permission: 'settings:read' },
    ],
  },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <img src="/favicon.svg" alt="" className="size-8" />
      <div>
        <div className="text-base leading-tight font-semibold">Argus</div>
        <div className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">Security monitoring</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?(): void }) {
  const { can } = useAuth();
  return (
    <nav className="flex flex-1 flex-col gap-6">
      {sections.map((section, i) => {
        const items = section.items.filter((it) => !it.permission || can(it.permission));
        if (!items.length) return null;
        return (
          <div key={i}>
            {section.title && <div className="mb-1.5 px-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">{section.title}</div>}
            <ul className="space-y-0.5">
              {items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    end={it.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium',
                        isActive
                          ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100',
                      )
                    }
                  >
                    <it.icon className="size-4 shrink-0" />
                    <span className="flex-1">{it.label}</span>
                    {it.soon && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 uppercase dark:bg-slate-800">Soon</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function UserMenu() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  if (!me) return null;
  return (
    <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
      <NavLink to="/profile" className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
        <UserCircle className="size-8 text-slate-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{me.displayName}</div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{ROLE_LABELS[me.role]}</div>
        </div>
      </NavLink>
      <button
        onClick={async () => {
          await logout();
          navigate('/login');
        }}
        className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
      >
        <LogOut className="size-4" />
        Sign out
      </button>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 print:!hidden flex-col gap-6 border-r border-slate-200 bg-white px-3 py-5 lg:sticky lg:top-0 lg:flex lg:h-screen dark:border-slate-800 dark:bg-slate-900">
        <Logo />
        <Sidebar />
        <UserMenu />
      </aside>

      <header className="sticky top-0 z-30 print:hidden flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden dark:border-slate-800 dark:bg-slate-900">
        <Logo />
        <button onClick={() => setOpen(true)} aria-label="Open navigation" className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
          <Menu className="size-5" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col gap-6 bg-white px-3 py-5 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <Logo />
              <button onClick={() => setOpen(false)} aria-label="Close navigation" className="rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                <X className="size-5" />
              </button>
            </div>
            <Sidebar onNavigate={() => setOpen(false)} />
            <UserMenu />
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

