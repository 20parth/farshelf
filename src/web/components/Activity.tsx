import { History } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ActivityItem } from '../../shared/schemas.ts';
import { api } from '../lib/api.ts';
import { formatDate } from '../lib/format.ts';
import { useStore } from '../lib/store.tsx';
import { Empty, Spinner } from './ui.tsx';

export function Activity() {
  const { activityVersion, fail, state } = useStore();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api.activity(q).then((r) => setItems(r.items), fail), 150);
    return () => clearTimeout(t);
  }, [q, activityVersion, fail]);
  const remoteName = (id: string | null) => (id ? state?.remotes.find((r) => r.id === id)?.name : null);
  return (
    <section aria-labelledby="activity-h" className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h1 id="activity-h" className="font-semibold">
          Activity
        </h1>
        <input
          type="search"
          aria-label="Search activity"
          placeholder="Search history…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-64 max-w-full rounded-lg border border-line bg-panel px-3 py-1.5 text-sm"
        />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {!items ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty icon={<History className="size-8" />} title={q ? 'No matching activity' : 'No activity yet'}>
            Everything Farshelf does (uploads, moves, unlocks, errors) is recorded here, on this computer
            only.
          </Empty>
        ) : (
          <ol aria-label="Activity history">
            {items.map((a) => (
              <li key={a.id} className="flex gap-3 border-b border-line px-4 py-2 text-sm">
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${a.level === 'error' ? 'bg-danger' : a.level === 'warn' ? 'bg-amber' : 'bg-accent'}`}
                  aria-label={a.level}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words">{a.message}</p>
                  <p className="text-xs text-muted">
                    <time dateTime={new Date(a.ts).toISOString()}>{formatDate(a.ts)}</time> · {a.action}
                    {remoteName(a.remoteId) && ` · ${remoteName(a.remoteId)}`}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
