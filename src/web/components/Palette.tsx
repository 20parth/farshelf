import { Check, File, Folder, Search, Sparkles, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { AiPlan, PlanStep, SearchFilter, SearchResult } from '../../shared/schemas.ts';
import { api } from '../lib/api.ts';
import { formatBytes, formatDate, isPreviewable, parentOf } from '../lib/format.ts';
import { useStore } from '../lib/store.tsx';
import { Button, copyText, Dialog, Kbd, Spinner } from './ui.tsx';

type Mode = 'search' | 'ai';

export function Palette() {
  const { paletteOpen, setPaletteOpen, state, view } = useStore();
  const [mode, setMode] = useState<Mode>('search');
  const aiEnabled = !!state?.settings.ai.enabled;
  const close = () => setPaletteOpen(false);
  const inFolder = view.name === 'files' && state?.remotes.some((r) => r.id === view.remoteId && !r.locked);
  return (
    <Dialog open={paletteOpen} onClose={close} title={mode === 'search' ? 'Search' : 'Ask AI'} wide>
      {aiEnabled && (
        <div role="tablist" aria-label="Mode" className="-mt-2 flex gap-1">
          {(['search', 'ai'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1 text-sm ${mode === m ? 'bg-accent-soft font-medium' : 'text-muted hover:bg-sunk'}`}
            >
              {m === 'search' ? 'Search names' : 'Ask AI'}
            </button>
          ))}
        </div>
      )}
      {mode === 'search' || !aiEnabled ? (
        <SearchPane onClose={close} />
      ) : (
        <AiPane onClose={close} inFolder={!!inFolder} />
      )}
    </Dialog>
  );
}

function useResultActions(onClose: () => void) {
  const { navigate, fail, toast } = useStore();
  return {
    async open(r: SearchResult) {
      onClose();
      if (r.kind === 'dir') return navigate({ name: 'files', remoteId: r.remoteId, path: r.path });
      try {
        const { url } = await api.link(r.remoteId, r.path);
        window.open(isPreviewable(r.name) ? url : `${url}&download=1`, '_blank', 'noopener');
      } catch (err) {
        fail(err);
      }
    },
    reveal(r: SearchResult) {
      onClose();
      navigate({ name: 'files', remoteId: r.remoteId, path: parentOf(r.path), focus: r.path });
    },
    async copy(r: SearchResult) {
      try {
        const { url } = await api.link(r.remoteId, r.path);
        const ok = await copyText(url);
        toast(ok ? 'success' : 'error', ok ? 'Stream link copied' : 'Could not copy the link');
      } catch (err) {
        fail(err);
      }
    },
  };
}

function ResultList({
  results,
  active,
  setActive,
  onClose,
  labelledBy,
}: {
  results: SearchResult[];
  active: number;
  setActive: (n: number) => void;
  onClose: () => void;
  labelledBy: string;
}) {
  const actions = useResultActions(onClose);
  return (
    <ul
      id={`${labelledBy}-list`}
      role="listbox"
      aria-labelledby={labelledBy}
      className="max-h-80 overflow-auto rounded-xl border border-line"
    >
      {results.map((r, i) => (
        <li
          key={`${r.remoteId}:${r.path}`}
          id={`result-${i}`}
          role="option"
          aria-selected={i === active}
          onMouseEnter={() => setActive(i)}
          onClick={() => void actions.open(r)}
          className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${i === active ? 'bg-accent-soft' : ''}`}
        >
          {r.kind === 'dir' ? (
            <Folder className="size-4 shrink-0 text-amber" aria-hidden />
          ) : (
            <File className="size-4 shrink-0 text-accent" aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{r.name}</span>
            <span className="block truncate text-xs text-muted">
              {r.remoteName} · {parentOf(r.path)}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted tabular-nums">
            {r.kind === 'file' ? formatBytes(r.size) : ''} {formatDate(r.mtime)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function useListKeys(results: SearchResult[], onClose: () => void) {
  const [active, setActive] = useState(0);
  const actions = useResultActions(onClose);
  useEffect(() => setActive(0), [results]);
  const onKeyDown = (e: KeyboardEvent) => {
    const r = results[active];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(results.length - 1, active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, active - 1));
    } else if (e.key === 'Enter' && r && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      actions.reveal(r);
    } else if (e.key === 'Enter' && r) {
      e.preventDefault();
      void actions.open(r);
    } else if ((e.key === 'c' || e.key === 'C') && e.shiftKey && (e.metaKey || e.ctrlKey) && r) {
      e.preventDefault();
      void actions.copy(r);
    }
  };
  return { active, setActive, onKeyDown };
}

function SearchPane({ onClose }: { onClose: () => void }) {
  const { fail } = useStore();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const labelId = useId();
  const keys = useListKeys(results, onClose);
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(
      () =>
        api
          .search({ text: q, limit: 30 })
          .then((r) => setResults(r.results), fail)
          .finally(() => setLoading(false)),
      120,
    );
    return () => clearTimeout(t);
  }, [q, fail]);
  return (
    <div className="flex flex-col gap-3">
      <label id={labelId} className="sr-only">
        Search file names across all storage
      </label>
      <div className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3">
        <Search className="size-4 text-muted" aria-hidden />
        <input
          autoFocus
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={`${labelId}-list`}
          aria-activedescendant={results.length ? `result-${keys.active}` : undefined}
          aria-labelledby={labelId}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={keys.onKeyDown}
          placeholder="Search file and folder names…"
          className="flex-1 bg-transparent py-2.5 text-sm outline-none"
        />
        {loading && <Spinner small />}
      </div>
      {q && !loading && results.length === 0 && (
        <p className="px-1 text-sm text-muted">
          No matches. Only indexed folders are searched; use Settings › Storage › Re-index if files are
          missing.
        </p>
      )}
      {results.length > 0 && (
        <ResultList
          results={results}
          active={keys.active}
          setActive={keys.setActive}
          onClose={onClose}
          labelledBy={labelId}
        />
      )}
      <p className="text-xs text-muted">
        <Kbd>Enter</Kbd> open · <Kbd>⌘ Enter</Kbd> show in folder · <Kbd>⌘ ⇧ C</Kbd> copy stream link ·{' '}
        <Kbd>Esc</Kbd> close
      </p>
    </div>
  );
}

function describeFilter(f: SearchFilter): string {
  const parts: string[] = [];
  if (f.text) parts.push(`name contains “${f.text}”`);
  if (f.kind) parts.push(f.kind === 'dir' ? 'folders' : 'files');
  if (f.category) parts.push(`${f.category} files`);
  if (f.extensions?.length) parts.push(`.${f.extensions.join(', .')}`);
  if (f.minSize !== undefined) parts.push(`≥ ${formatBytes(f.minSize)}`);
  if (f.maxSize !== undefined) parts.push(`≤ ${formatBytes(f.maxSize)}`);
  if (f.modifiedAfter) parts.push(`modified after ${f.modifiedAfter}`);
  if (f.modifiedBefore) parts.push(`modified before ${f.modifiedBefore}`);
  if (f.sort !== 'relevance') parts.push(`sorted by ${f.sort} ${f.order}`);
  return parts.join(' · ') || 'everything';
}

function AiPane({ onClose, inFolder }: { onClose: () => void; inFolder: boolean }) {
  const { view } = useStore();
  const [q, setQ] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState<'find' | 'plan' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ filter: SearchFilter; results: SearchResult[] } | null>(null);
  const [plan, setPlan] = useState<{ plan: AiPlan; note: string | null } | null>(null);
  const labelId = useId();
  const keys = useListKeys(found?.results ?? [], onClose);
  const abort = useRef(false);

  async function run(kind: 'find' | 'plan') {
    setBusy(kind);
    setError(null);
    setFound(null);
    setPlan(null);
    abort.current = false;
    try {
      if (kind === 'find') {
        const r = await api.aiSearch(q);
        if (!abort.current) setFound(r);
      } else if (view.name === 'files') {
        const r = await api.aiPlan({
          request: q,
          remoteId: view.remoteId,
          cwd: view.path,
          shareNames: share,
        });
        if (!abort.current)
          setPlan({
            plan: r.plan,
            note: r.encryptedWithheld
              ? 'Names were not shared because this storage is encrypted.'
              : r.sharedNames
                ? null
                : 'File names were not shared, so the plan may be generic.',
          });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label id={labelId} htmlFor={`${labelId}-in`} className="text-sm text-muted">
        Describe what you want, e.g. “videos over 5 GB from this year” or “put all the wav files here into a
        folder called stems”.
      </label>
      <textarea
        id={`${labelId}-in`}
        autoFocus
        rows={2}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && q.trim()) {
            e.preventDefault();
            void run('find');
          } else keys.onKeyDown(e);
        }}
        className="rounded-xl border border-line bg-paper px-3 py-2 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          busy={busy === 'find'}
          disabled={!q.trim() || !!busy}
          onClick={() => void run('find')}
        >
          <Search className="size-4" aria-hidden /> Find files
        </Button>
        <Button
          busy={busy === 'plan'}
          disabled={!q.trim() || !!busy || !inFolder}
          onClick={() => void run('plan')}
          title={inFolder ? '' : 'Open a folder first'}
        >
          <Sparkles className="size-4" aria-hidden /> Plan changes in this folder
        </Button>
        {busy && (
          <Button
            variant="ghost"
            onClick={() => {
              abort.current = true;
              setBusy(null);
            }}
          >
            Cancel
          </Button>
        )}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={share}
            onChange={(e) => setShare(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Share names in this folder with the model
        </label>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      {found && (
        <>
          <p className="text-xs">
            <span className="rounded bg-amber-soft px-1.5 py-0.5 text-amber">AI-generated filter</span>{' '}
            <span className="text-muted">{describeFilter(found.filter)}</span> ·{' '}
            <strong>{found.results.length}</strong> result{found.results.length === 1 ? '' : 's'} from your
            local index
          </p>
          {found.results.length > 0 && (
            <ResultList
              results={found.results}
              active={keys.active}
              setActive={keys.setActive}
              onClose={onClose}
              labelledBy={labelId}
            />
          )}
        </>
      )}
      {plan && view.name === 'files' && (
        <PlanReview plan={plan.plan} note={plan.note} remoteId={view.remoteId} onDone={onClose} />
      )}
    </div>
  );
}

function stepText(s: PlanStep): string {
  if (s.tool === 'mkdir') return `Create folder ${s.path}`;
  if (s.tool === 'move') return `Move ${s.from} → ${s.to}`;
  return `Move ${s.path} to trash`;
}

export function PlanReview({
  plan,
  note,
  remoteId,
  onDone,
}: {
  plan: AiPlan;
  note: string | null;
  remoteId: string;
  onDone: () => void;
}) {
  const { toast, refresh } = useStore();
  const [chosen, setChosen] = useState<boolean[]>(() => plan.steps.map(() => true));
  const [status, setStatus] = useState<(null | 'running' | 'ok' | string)[]>(() =>
    plan.steps.map(() => null),
  );
  const [running, setRunning] = useState(false);
  const finished = status.some((s) => s !== null && s !== 'running') && !running;

  async function execute() {
    setRunning(true);
    let ok = 0;
    for (let i = 0; i < plan.steps.length; i++) {
      if (!chosen[i]) continue;
      const s = plan.steps[i]!;
      setStatus((st) => st.map((v, j) => (j === i ? 'running' : v)));
      try {
        if (s.tool === 'mkdir') await api.mkdir(remoteId, s.path, 'ai');
        else if (s.tool === 'move') await api.move(remoteId, s.from, s.to, 'ai');
        else await api.trash(remoteId, s.path, 'ai');
        ok++;
        setStatus((st) => st.map((v, j) => (j === i ? 'ok' : v)));
      } catch (err) {
        setStatus((st) =>
          st.map((v, j) => (j === i ? (err instanceof Error ? err.message : String(err)) : v)),
        );
      }
    }
    setRunning(false);
    toast('info', `Ran ${ok} approved step${ok === 1 ? '' : 's'}`);
    void refresh();
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber p-3" aria-label="Proposed plan">
      <p className="text-xs">
        <span className="rounded bg-amber-soft px-1.5 py-0.5 text-amber">
          Suggested by AI. Review before running.
        </span>
      </p>
      <p className="text-sm">{plan.summary}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
      {plan.steps.length === 0 ? (
        <p className="text-sm text-muted">No changes proposed.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {plan.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={`Approve: ${stepText(s)}`}
                checked={chosen[i]}
                disabled={running || finished}
                onChange={(e) => setChosen((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
                className="mt-1 accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className={`block break-all ${s.tool === 'trash' ? 'text-danger' : ''}`}>
                  {stepText(s)}
                </span>
                {s.reason && <span className="block text-xs text-muted">{s.reason}</span>}
                {status[i] && status[i] !== 'running' && status[i] !== 'ok' && (
                  <span className="block text-xs text-danger">{status[i]}</span>
                )}
              </span>
              <span className="shrink-0" aria-live="polite">
                {status[i] === 'running' && <Spinner small />}
                {status[i] === 'ok' && <Check className="size-4 text-ok" aria-label="done" />}
                {status[i] && status[i] !== 'running' && status[i] !== 'ok' && (
                  <X className="size-4 text-danger" aria-label="failed" />
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="flex justify-end gap-2">
        {finished ? (
          <Button variant="primary" onClick={onDone}>
            Close
          </Button>
        ) : (
          plan.steps.length > 0 && (
            <Button
              variant="primary"
              busy={running}
              disabled={!chosen.some(Boolean)}
              onClick={() => void execute()}
            >
              Run {chosen.filter(Boolean).length} approved step
              {chosen.filter(Boolean).length === 1 ? '' : 's'}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
