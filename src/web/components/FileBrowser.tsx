import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderInput,
  FolderPlus,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Entry, RemoteInfo } from '../../shared/schemas.ts';
import { api, ApiError } from '../lib/api.ts';
import {
  baseName,
  fileKind,
  formatBytes,
  formatDate,
  isPreviewable,
  joinPath,
  parentOf,
} from '../lib/format.ts';
import { useStore } from '../lib/store.tsx';
import { Button, copyText, Dialog, Empty, Field, IconButton, Kbd, Progress, Spinner } from './ui.tsx';
import { Unlock } from './Unlock.tsx';

type SortKey = 'name' | 'size' | 'mtime';

const ICONS = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  document: FileText,
  archive: FileArchive,
  other: File,
};

interface DroppedFile {
  file: File;
  rel: string;
}

async function collectEntries(items: DataTransferItemList): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  for (const e of entries) await walk(e, '');
  return out;
}

export function FileBrowser({ remote, path, focus }: { remote: RemoteInfo; path: string; focus?: string }) {
  const { navigate, changes, jobs, fail, toast, state, setPaletteOpen } = useStore();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<
    | null
    | { kind: 'mkdir' }
    | { kind: 'rename'; entry: Entry }
    | { kind: 'move'; entry: Entry }
    | { kind: 'trash'; entry: Entry }
  >(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const changeKey = changes.get(`${remote.id}:${path}`) ?? 0;

  const load = useCallback(async () => {
    if (remote.locked) return;
    setLoading(true);
    try {
      const { entries } = await api.list(remote.id, path);
      setEntries(entries);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setLoading(false);
    }
  }, [remote.id, remote.locked, path]);

  useEffect(() => {
    setEntries(null);
    setSelected(focus ?? null);
  }, [remote.id, path, focus]);

  useEffect(() => {
    void load();
  }, [load, changeKey]);

  const sorted = useMemo(() => {
    if (!entries) return [];
    return [...entries].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      const v =
        sort.key === 'name'
          ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          : a[sort.key] - b[sort.key];
      return v * sort.dir;
    });
  }, [entries, sort]);

  const uploadJobs = useMemo(() => {
    const m = new Map<string, { progress: number; total: number; state: string }>();
    for (const j of jobs.values())
      if (j.kind === 'upload' && j.remoteId === remote.id && !['done', 'cancelled'].includes(j.state))
        m.set(j.path, j);
    return m;
  }, [jobs, remote.id]);

  // Focus the selected row (e.g. after "show in folder" from search).
  useEffect(() => {
    if (!selected || !entries) return;
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`);
    if (dialog) return;
    row?.focus();
  }, [selected, entries, dialog]);

  async function open(e: Entry) {
    if (e.kind === 'dir') return navigate({ name: 'files', remoteId: remote.id, path: e.path });
    try {
      const { url } = await api.link(remote.id, e.path);
      window.open(isPreviewable(e.name) ? url : `${url}&download=1`, '_blank', 'noopener');
    } catch (err) {
      fail(err);
    }
  }

  async function copyLink(e: Entry) {
    try {
      const { url } = await api.link(remote.id, e.path);
      const ok = await copyText(url);
      toast(
        ok ? 'success' : 'error',
        ok ? 'Stream link copied. Paste it into VLC, IINA or a browser.' : 'Could not copy the link',
      );
    } catch (err) {
      fail(err);
    }
  }

  async function uploadFiles(files: DroppedFile[]) {
    if (!files.length) return;
    let ok = 0;
    for (const { file, rel } of files) {
      try {
        await api.upload(remote.id, joinPath(path, rel), file, file.lastModified);
        ok++;
      } catch (err) {
        fail(err);
      }
    }
    if (ok) toast('info', `${ok} file${ok === 1 ? '' : 's'} queued for upload. Track them in Transfers.`);
    void load();
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (remote.locked) return;
    const files = e.dataTransfer.items?.length
      ? await collectEntries(e.dataTransfer.items)
      : [...e.dataTransfer.files].map((f) => ({ file: f, rel: f.name }));
    await uploadFiles(files);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTableSectionElement>) {
    const idx = sorted.findIndex((x) => x.path === selected);
    const cur = sorted[idx];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = sorted[Math.max(0, Math.min(sorted.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setSelected(next.path);
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      void open(cur);
    } else if ((e.key === 'Backspace' && !e.metaKey) || (e.key === 'ArrowUp' && e.altKey)) {
      e.preventDefault();
      if (path !== '/') navigate({ name: 'files', remoteId: remote.id, path: parentOf(path), focus: path });
    } else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && cur) {
      e.preventDefault();
      setDialog({ kind: 'trash', entry: cur });
    } else if (e.key === 'F2' && cur) {
      e.preventDefault();
      setDialog({ kind: 'rename', entry: cur });
    }
  }

  const segments = path.split('/').filter(Boolean);
  const header = (key: SortKey, label: string, className = '') => (
    <th
      scope="col"
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      className={`px-3 py-2 font-medium ${className}`}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-ink"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      >
        {label}
        {sort.key === key &&
          (sort.dir === 1 ? (
            <ArrowUp className="size-3" aria-hidden />
          ) : (
            <ArrowDown className="size-3" aria-hidden />
          ))}
      </button>
    </th>
  );

  return (
    <section
      aria-label={`Files in ${remote.name}`}
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (remote.locked) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <button
            type="button"
            className="truncate rounded px-1 font-semibold hover:bg-sunk"
            onClick={() => navigate({ name: 'files', remoteId: remote.id, path: '/' })}
          >
            {remote.name}
          </button>
          {segments.map((s, i) => {
            const p = '/' + segments.slice(0, i + 1).join('/');
            const last = i === segments.length - 1;
            return (
              <span key={p} className="flex min-w-0 items-center gap-1">
                <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                <button
                  type="button"
                  aria-current={last ? 'page' : undefined}
                  className={`truncate rounded px-1 hover:bg-sunk ${last ? 'font-medium' : 'text-muted'}`}
                  onClick={() => navigate({ name: 'files', remoteId: remote.id, path: p })}
                >
                  {s}
                </button>
              </span>
            );
          })}
        </nav>
        {!remote.locked && (
          <div className="flex items-center gap-1">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) =>
                void uploadFiles([...(e.target.files ?? [])].map((f) => ({ file: f, rel: f.name }))).then(
                  () => (e.target.value = ''),
                )
              }
            />
            <Button variant="primary" onClick={() => fileInput.current?.click()}>
              <Upload className="size-4" aria-hidden /> Upload
            </Button>
            <Button onClick={() => setDialog({ kind: 'mkdir' })}>
              <FolderPlus className="size-4" aria-hidden /> New folder
            </Button>
            {state?.settings.ai.enabled && (
              <Button
                onClick={() => setPaletteOpen(true)}
                title="Ask the AI assistant to organise this folder"
              >
                <Sparkles className="size-4" aria-hidden /> Ask AI
              </Button>
            )}
            <IconButton label="Refresh" onClick={() => void load()}>
              {loading ? <Spinner small /> : <RefreshCw className="size-4" />}
            </IconButton>
          </div>
        )}
      </header>

      {remote.locked ? (
        <Unlock remote={remote} />
      ) : error ? (
        <Empty title={error.status === 404 ? 'This folder no longer exists' : 'Could not load this folder'}>
          <p>{error.message}</p>
          <div className="mt-3 flex justify-center gap-2">
            <Button onClick={() => void load()}>Try again</Button>
            {path !== '/' && (
              <Button onClick={() => navigate({ name: 'files', remoteId: remote.id, path: '/' })}>
                Go to top
              </Button>
            )}
          </div>
        </Empty>
      ) : !entries ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted" role="status">
          <Spinner /> Loading…
        </div>
      ) : sorted.length === 0 ? (
        <Empty icon={<Upload className="size-8" />} title="This folder is empty">
          Drag files or whole folders here, or use <strong>Upload</strong>. Files are uploaded in the
          background and stay available while they upload.
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-paper text-left text-xs text-muted">
              <tr>
                {header('name', 'Name', 'w-auto')}
                {header('size', 'Size', 'w-24 text-right')}
                {header('mtime', 'Modified', 'hidden w-36 sm:table-cell')}
                <th scope="col" className="w-32 px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody ref={tableRef} onKeyDown={onKeyDown}>
              {sorted.map((e) => {
                const Icon = e.kind === 'dir' ? Folder : ICONS[fileKind(e.name)];
                const up = uploadJobs.get(e.path);
                const isSel = selected === e.path;
                return (
                  <tr
                    key={e.path}
                    data-path={e.path}
                    tabIndex={isSel || (!selected && e === sorted[0]) ? 0 : -1}
                    aria-selected={isSel}
                    onFocus={() => setSelected(e.path)}
                    onClick={() => setSelected(e.path)}
                    onDoubleClick={() => void open(e)}
                    className={`group border-b border-line/60 outline-none ${isSel ? 'bg-accent-soft' : 'hover:bg-sunk'} focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon
                          className={`size-4 shrink-0 ${e.kind === 'dir' ? 'text-amber' : 'text-accent'}`}
                          aria-hidden
                        />
                        <button
                          type="button"
                          tabIndex={-1}
                          className="truncate text-left hover:underline"
                          onClick={() => void open(e)}
                          title={e.name}
                        >
                          {e.name}
                        </button>
                        {e.pending && (
                          <span className="shrink-0 rounded-full bg-amber-soft px-2 text-[11px] text-amber">
                            {up ? (up.state === 'running' ? 'uploading' : up.state) : 'uploading'}
                          </span>
                        )}
                      </div>
                      {up && up.state === 'running' && (
                        <div className="mt-1 ml-6 max-w-xs">
                          <Progress value={up.progress} max={up.total} label={`Uploading ${e.name}`} />
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">
                      {e.kind === 'dir' ? '—' : formatBytes(e.size)}
                    </td>
                    <td className="hidden px-3 py-2 text-muted sm:table-cell">{formatDate(e.mtime)}</td>
                    <td className="px-2 py-1">
                      <div className="flex justify-end opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                        {e.kind === 'file' && (
                          <IconButton
                            label={`Copy stream link for ${e.name}`}
                            tabIndex={-1}
                            onClick={() => void copyLink(e)}
                          >
                            <Copy className="size-4" />
                          </IconButton>
                        )}
                        <IconButton
                          label={`Rename ${e.name}`}
                          tabIndex={-1}
                          disabled={e.pending}
                          onClick={() => setDialog({ kind: 'rename', entry: e })}
                        >
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton
                          label={`Move ${e.name}`}
                          tabIndex={-1}
                          disabled={e.pending}
                          onClick={() => setDialog({ kind: 'move', entry: e })}
                        >
                          <FolderInput className="size-4" />
                        </IconButton>
                        <IconButton
                          label={`Move ${e.name} to trash`}
                          tabIndex={-1}
                          onClick={() => setDialog({ kind: 'trash', entry: e })}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-muted">
            {sorted.length} item{sorted.length === 1 ? '' : 's'} ·{' '}
            {formatBytes(sorted.reduce((n, e) => n + e.size, 0))} in {remote.name}. Keys: <Kbd>↑</Kbd>{' '}
            <Kbd>↓</Kbd> move, <Kbd>Enter</Kbd> open, <Kbd>⌫</Kbd> up a folder, <Kbd>F2</Kbd> rename,{' '}
            <Kbd>Del</Kbd> trash.
          </p>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft/80 text-lg font-medium">
          Drop to upload into {path === '/' ? remote.name : baseName(path)}
        </div>
      )}

      <NameDialog
        open={dialog?.kind === 'mkdir' || dialog?.kind === 'rename'}
        title={dialog?.kind === 'rename' ? `Rename “${dialog.entry.name}”` : 'New folder'}
        initial={dialog?.kind === 'rename' ? dialog.entry.name : 'Untitled folder'}
        action={dialog?.kind === 'rename' ? 'Rename' : 'Create'}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          const target =
            dialog?.kind === 'rename' ? joinPath(parentOf(dialog.entry.path), name) : joinPath(path, name);
          if (dialog?.kind === 'rename') await api.move(remote.id, dialog.entry.path, target);
          else await api.mkdir(remote.id, target);
          // Reload before closing, so the dialog cannot hand focus back to the old row;
          // then keep keyboard focus on the item the user just created or renamed.
          await load();
          setSelected(target);
          setDialog(null);
        }}
      />
      <MoveDialog
        open={dialog?.kind === 'move'}
        entry={dialog?.kind === 'move' ? dialog.entry : null}
        onClose={() => setDialog(null)}
        onSubmit={async (dest) => {
          if (dialog?.kind !== 'move') return;
          await api.move(remote.id, dialog.entry.path, joinPath(dest, dialog.entry.name));
          setDialog(null);
          toast('success', `Moved to ${dest}`);
          void load();
        }}
      />
      <Dialog open={dialog?.kind === 'trash'} title="Move to trash?" onClose={() => setDialog(null)}>
        {dialog?.kind === 'trash' && (
          <>
            <p className="text-sm">
              “{dialog.entry.name}”{' '}
              {dialog.entry.pending
                ? 'has not finished uploading; its upload will be cancelled.'
                : `will be kept in the trash for ${state?.settings.trashRetentionDays ?? 30} days and can be restored.`}
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                variant="danger"
                autoFocus
                onClick={async () => {
                  try {
                    await api.trash(remote.id, dialog.entry.path);
                    toast('info', `Moved “${dialog.entry.name}” to trash`);
                    setDialog(null);
                    void load();
                  } catch (err) {
                    fail(err);
                  }
                }}
              >
                Move to trash
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}

function NameDialog({
  open,
  title,
  initial,
  action,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: string;
  action: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);
  const invalid = !name.trim()
    ? 'Enter a name'
    : /[/\\]/.test(name)
      ? 'Names cannot contain / or \\'
      : name === '.' || name === '..'
        ? 'That name is reserved'
        : null;
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (invalid) return setError(invalid);
          setBusy(true);
          try {
            await onSubmit(name.trim());
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Name"
          value={name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          error={error}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveDialog({
  open,
  entry,
  onClose,
  onSubmit,
}: {
  open: boolean;
  entry: Entry | null;
  onClose: () => void;
  onSubmit: (dest: string) => Promise<void>;
}) {
  const [dest, setDest] = useState('/');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && entry) {
      setDest(parentOf(entry.path));
      setError(null);
    }
  }, [open, entry]);
  return (
    <Dialog open={open} title={`Move “${entry?.name ?? ''}”`} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const d = '/' + dest.split('/').filter(Boolean).join('/');
          try {
            await onSubmit(d);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        <Field
          label="Destination folder"
          value={dest}
          autoFocus
          onChange={(e) => setDest(e.target.value)}
          hint="A path inside this storage, e.g. /Archive/2026. Missing folders are created."
          error={error}
        />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            Move
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
