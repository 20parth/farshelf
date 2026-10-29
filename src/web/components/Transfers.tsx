import { ArrowUpFromLine, Pause, Play, RotateCcw, Search, X } from 'lucide-react';
import { useMemo } from 'react';
import type { JobInfo } from '../../shared/schemas.ts';
import { api } from '../lib/api.ts';
import { formatBytes, formatDate, formatEta } from '../lib/format.ts';
import { useStore } from '../lib/store.tsx';
import { Button, Empty, IconButton, Progress } from './ui.tsx';

const STATE_LABEL: Record<JobInfo['state'], string> = {
  queued: 'Waiting',
  running: 'In progress',
  paused: 'Paused',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function Transfers() {
  const { jobs, state, fail, refresh } = useStore();
  const list = useMemo(() => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt), [jobs]);
  const active = list.filter((j) => ['queued', 'running', 'paused', 'failed'].includes(j.state));
  const finished = list.filter((j) => j.state === 'done' || j.state === 'cancelled');
  const remoteName = (id: string) => state?.remotes.find((r) => r.id === id)?.name ?? 'removed storage';
  const act = (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') =>
    api.jobAction(id, action).catch(fail);
  const totals = active
    .filter((j) => j.kind === 'upload')
    .reduce((t, j) => ({ done: t.done + j.progress, total: t.total + j.total, rate: t.rate + j.rate }), {
      done: 0,
      total: 0,
      rate: 0,
    });

  const row = (j: JobInfo) => (
    <li key={j.id} className="flex flex-col gap-1.5 border-b border-line px-4 py-3">
      <div className="flex items-center gap-3">
        {j.kind === 'upload' ? (
          <ArrowUpFromLine className="size-4 shrink-0 text-accent" aria-hidden />
        ) : (
          <Search className="size-4 shrink-0 text-accent" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={j.path}>
            {j.label}
          </p>
          <p className="truncate text-xs text-muted">
            {remoteName(j.remoteId)} · {j.path} · {STATE_LABEL[j.state]}
            {j.kind === 'upload' && j.total > 0 && ` · ${formatBytes(j.progress)} of ${formatBytes(j.total)}`}
            {j.kind === 'index' && j.state === 'running' && ` · ${j.progress} folders scanned`}
            {j.state === 'running' &&
              j.rate > 0 &&
              ` · ${formatBytes(j.rate)}/s · ${formatEta(j.total - j.progress, j.rate)}`}
            {(j.state === 'done' || j.state === 'cancelled') && ` · ${formatDate(j.updatedAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-0.5">
          {(j.state === 'running' || j.state === 'queued') && (
            <IconButton label={`Pause ${j.label}`} onClick={() => act(j.id, 'pause')}>
              <Pause className="size-4" />
            </IconButton>
          )}
          {j.state === 'paused' && (
            <IconButton label={`Resume ${j.label}`} onClick={() => act(j.id, 'resume')}>
              <Play className="size-4" />
            </IconButton>
          )}
          {j.state === 'failed' && (
            <IconButton label={`Retry ${j.label}`} onClick={() => act(j.id, 'retry')}>
              <RotateCcw className="size-4" />
            </IconButton>
          )}
          {!['done', 'cancelled'].includes(j.state) && (
            <IconButton label={`Cancel ${j.label}`} onClick={() => act(j.id, 'cancel')}>
              <X className="size-4" />
            </IconButton>
          )}
        </div>
      </div>
      {j.kind === 'upload' && ['running', 'paused', 'queued'].includes(j.state) && (
        <Progress value={j.progress} max={j.total} label={`${j.label} progress`} />
      )}
      {j.error && (
        <p
          className={`text-xs ${j.state === 'failed' ? 'text-danger' : 'text-amber'}`}
          role={j.state === 'failed' ? 'alert' : undefined}
        >
          {j.error}
        </p>
      )}
    </li>
  );

  return (
    <section aria-labelledby="transfers-h" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h1 id="transfers-h" className="font-semibold">
            Transfers
          </h1>
          <p className="text-xs text-muted" role="status">
            {active.length
              ? `${active.length} active · ${formatBytes(totals.done)} of ${formatBytes(totals.total)}${totals.rate ? ` · ${formatEta(totals.total - totals.done, totals.rate)}` : ''}`
              : 'Nothing in progress. Uploads continue after restarts and reconnects.'}
          </p>
        </div>
        {finished.length > 0 && (
          <Button onClick={() => api.clearJobs().then(refresh, fail)}>Clear finished</Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {list.length === 0 ? (
          <Empty icon={<ArrowUpFromLine className="size-8" />} title="No transfers yet">
            Uploads and indexing jobs appear here with their progress.
          </Empty>
        ) : (
          <ul aria-label="Transfers">
            {active.map(row)}
            {finished.map(row)}
          </ul>
        )}
      </div>
    </section>
  );
}
