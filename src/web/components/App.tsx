import {
  ArrowUpFromLine,
  Cloud,
  FolderOpen,
  Globe,
  History,
  Lock,
  Menu,
  Plus,
  Search,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RemoteInfo } from '../../shared/schemas.ts';
import { useStore, type View } from '../lib/store.tsx';
import { Activity } from './Activity.tsx';
import { AddRemote } from './AddRemote.tsx';
import { FileBrowser } from './FileBrowser.tsx';
import { Palette } from './Palette.tsx';
import { Settings } from './Settings.tsx';
import { Transfers } from './Transfers.tsx';
import { Trash } from './Trash.tsx';
import { Button, Dialog, Kbd, Logo, Spinner, Toasts } from './ui.tsx';

const KIND_ICON = { local: FolderOpen, webdav: Globe, gdrive: Cloud };

export function App() {
  const { state, authError, loadError, refresh, setPaletteOpen } = useStore();
  // Stay in onboarding until it finishes, even after live updates add the first remote (the recovery key step needs this).
  const [onboarding, setOnboarding] = useState(false);
  const noRemotes = state?.remotes.length === 0;
  useEffect(() => {
    if (noRemotes) setOnboarding(true);
  }, [noRemotes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  if (authError) {
    return (
      <Centered>
        <Logo size={40} />
        <h1 className="text-xl font-semibold">Sign in to Farshelf</h1>
        <p className="text-sm text-muted">
          For your security, this page only opens from the private link printed when Farshelf starts. In a
          terminal, run <code className="rounded bg-sunk px-1">farshelf url</code> and open the link it shows.
        </p>
      </Centered>
    );
  }
  if (loadError) {
    return (
      <Centered>
        <Logo size={40} />
        <h1 className="text-xl font-semibold">Can’t reach Farshelf</h1>
        <p className="text-sm text-muted">{loadError}</p>
        <Button onClick={() => void refresh()}>Try again</Button>
      </Centered>
    );
  }
  if (!state) {
    return (
      <Centered>
        <Spinner />
        <span className="sr-only">Loading</span>
      </Centered>
    );
  }
  if (state.remotes.length === 0 || onboarding) return <Onboarding onFinish={() => setOnboarding(false)} />;
  return (
    <>
      <Shell />
      <Palette />
      <Toasts />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      {children}
    </main>
  );
}

function Onboarding({ onFinish }: { onFinish: () => void }) {
  const { navigate } = useStore();
  return (
    <main className="mx-auto flex min-h-full max-w-xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center gap-3">
        <Logo size={40} />
        <div>
          <h1 className="text-2xl font-semibold">Welcome to Farshelf</h1>
          <p className="text-sm text-muted">
            Keep big files on storage you control, and open them like they were on this computer.
          </p>
        </div>
      </div>
      <ol className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        {['Pick where files live', 'Drop your biggest folders in', 'Open, stream or mount them anywhere'].map(
          (t, i) => (
            <li key={t} className="rounded-xl border border-line bg-panel p-3">
              <span className="mb-1 block text-xs font-semibold text-accent">Step {i + 1}</span>
              {t}
            </li>
          ),
        )}
      </ol>
      <div className="rounded-2xl border border-line bg-panel p-5">
        <AddRemote
          onDone={(r) => {
            navigate({ name: 'files', remoteId: r.id, path: '/' });
            onFinish();
          }}
        />
      </div>
      <p className="text-center text-xs text-muted">
        Free and open source. No account, no telemetry. Your files never pass through anyone else’s server.
      </p>
      <Toasts />
    </main>
  );
}

function NavButton({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Cloud;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${active ? 'bg-accent-soft font-medium' : 'hover:bg-sunk'}`}
    >
      <Icon className="size-4 shrink-0 text-accent" aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-amber-soft px-1.5 text-xs text-amber">{badge}</span>}
    </button>
  );
}

function Sidebar({ onPick }: { onPick: () => void }) {
  const { state, view, navigate, jobs, setPaletteOpen } = useStore();
  const [adding, setAdding] = useState(false);
  const activeJobs = [...jobs.values()].filter((j) =>
    ['queued', 'running', 'paused', 'failed'].includes(j.state),
  ).length;
  const go = (v: View) => {
    navigate(v);
    onPick();
  };
  const remoteButton = (r: RemoteInfo) => {
    const Icon = KIND_ICON[r.kind];
    return (
      <li key={r.id}>
        <NavButton
          active={view.name === 'files' && view.remoteId === r.id}
          onClick={() => go({ name: 'files', remoteId: r.id, path: '/' })}
          icon={r.locked ? Lock : Icon}
          label={r.name}
        />
      </li>
    );
  };
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 p-3">
      <div className="flex items-center gap-2 px-1">
        <Logo />
        <span className="text-lg font-semibold tracking-tight">Farshelf</span>
      </div>
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm text-muted hover:text-ink"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search</span>
        <Kbd>⌘K</Kbd>
      </button>
      <div>
        <h2 className="px-2.5 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">Storage</h2>
        <ul className="flex flex-col gap-0.5">{state!.remotes.map(remoteButton)}</ul>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-sunk hover:text-ink"
        >
          <Plus className="size-4" aria-hidden /> Add storage
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        <li>
          <NavButton
            active={view.name === 'transfers'}
            onClick={() => go({ name: 'transfers' })}
            icon={ArrowUpFromLine}
            label="Transfers"
            badge={activeJobs}
          />
        </li>
        <li>
          <NavButton
            active={view.name === 'activity'}
            onClick={() => go({ name: 'activity' })}
            icon={History}
            label="Activity"
          />
        </li>
        <li>
          <NavButton
            active={view.name === 'trash'}
            onClick={() => go({ name: 'trash' })}
            icon={Trash2}
            label="Trash"
          />
        </li>
        <li>
          <NavButton
            active={view.name === 'settings'}
            onClick={() => go({ name: 'settings' })}
            icon={SettingsIcon}
            label="Settings"
          />
        </li>
      </ul>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Add storage" wide>
        <AddRemote
          onCancel={() => setAdding(false)}
          onDone={(r) => {
            setAdding(false);
            go({ name: 'files', remoteId: r.id, path: '/' });
          }}
        />
      </Dialog>
    </nav>
  );
}

function Shell() {
  const { state, view } = useStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const remote =
    view.name === 'files' ? (state!.remotes.find((r) => r.id === view.remoteId) ?? state!.remotes[0]) : null;
  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-panel focus:p-2"
      >
        Skip to content
      </a>
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 border-r border-line bg-paper transition-transform md:static md:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <Sidebar onPick={() => setMenuOpen(false)} />
      </aside>
      {menuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden
        />
      )}
      <main id="main" className="flex min-w-0 flex-1 flex-col bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="rounded p-1.5 hover:bg-sunk"
          >
            <Menu className="size-5" />
          </button>
          <Logo size={22} />
          <span className="font-semibold">Farshelf</span>
        </div>
        {view.name === 'files' && remote && (
          <FileBrowser
            key={remote.id}
            remote={remote}
            path={view.remoteId === remote.id ? view.path : '/'}
            focus={view.focus}
          />
        )}
        {view.name === 'transfers' && <Transfers />}
        {view.name === 'activity' && <Activity />}
        {view.name === 'trash' && <Trash />}
        {view.name === 'settings' && <Settings />}
      </main>
    </div>
  );
}
