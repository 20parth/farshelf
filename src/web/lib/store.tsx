import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppState, JobInfo } from '../../shared/schemas.ts';
import { api, ApiError } from './api.ts';

export type View =
  | { name: 'files'; remoteId: string; path: string; focus?: string }
  | { name: 'transfers' }
  | { name: 'activity' }
  | { name: 'trash' }
  | { name: 'settings'; section?: string };

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

interface Store {
  state: AppState | null;
  authError: ApiError | null;
  loadError: string | null;
  jobs: Map<string, JobInfo>;
  view: View;
  navigate(v: View): void;
  refresh(): Promise<void>;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  toasts: Toast[];
  /** Incremented when a folder changes on the server; key = `${remoteId}:${path}` */
  changes: Map<string, number>;
  trashVersion: number;
  activityVersion: number;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  /** Report an error from any action as a toast. */
  fail(err: unknown): void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside provider');
  return s;
}

const VIEW_KEY = 'farshelf:view';

function initialView(): View {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved) return JSON.parse(saved) as View;
  } catch {
    // storage unavailable: fine
  }
  return { name: 'files', remoteId: '', path: '/' };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [authError, setAuthError] = useState<ApiError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Map<string, JobInfo>>(new Map());
  const [view, setView] = useState<View>(initialView);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [changes, setChanges] = useState<Map<string, number>>(new Map());
  const [trashVersion, setTrashVersion] = useState(0);
  const [activityVersion, setActivityVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const fail = useCallback(
    (err: unknown) => toast('error', err instanceof Error ? err.message : String(err)),
    [toast],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api.state(), api.jobs()]);
      setState(s);
      setJobs(new Map(j.jobs.map((x) => [x.id, x])));
      setAuthError(null);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setAuthError(err);
      else setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates from the daemon.
  useEffect(() => {
    if (!state) return;
    const es = new EventSource('/api/events');
    es.addEventListener('job', (e) => {
      const job = JSON.parse((e as MessageEvent).data) as JobInfo;
      setJobs((m) => new Map(m).set(job.id, job));
    });
    es.addEventListener('changed', (e) => {
      const { remoteId, path } = JSON.parse((e as MessageEvent).data) as { remoteId: string; path: string };
      setChanges((m) => new Map(m).set(`${remoteId}:${path}`, (m.get(`${remoteId}:${path}`) ?? 0) + 1));
    });
    es.addEventListener('state', (e) => setState(JSON.parse((e as MessageEvent).data) as AppState));
    es.addEventListener('trash', () => setTrashVersion((v) => v + 1));
    es.addEventListener('activity', () => setActivityVersion((v) => v + 1));
    es.onerror = () => {
      // EventSource reconnects by itself; re-sync once it is back.
      es.onopen = () => void refresh();
    };
    return () => es.close();
    // Only reconnect when we go from "no state" to "state".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!state, refresh]);

  // Keep the view valid when remotes change.
  const remotes = state?.remotes;
  useEffect(() => {
    if (!remotes) return;
    if (view.name === 'files' && !remotes.some((r) => r.id === view.remoteId) && remotes[0]) {
      setView({ name: 'files', remoteId: remotes[0].id, path: '/' });
    }
  }, [remotes, view]);

  const navigate = useCallback((v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(v.name === 'files' ? { ...v, focus: undefined } : v));
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo<Store>(
    () => ({
      state,
      authError,
      loadError,
      jobs,
      view,
      navigate,
      refresh,
      toast,
      dismissToast,
      toasts,
      changes,
      trashVersion,
      activityVersion,
      paletteOpen,
      setPaletteOpen,
      fail,
    }),
    [
      state,
      authError,
      loadError,
      jobs,
      view,
      navigate,
      refresh,
      toast,
      dismissToast,
      toasts,
      changes,
      trashVersion,
      activityVersion,
      paletteOpen,
      fail,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
