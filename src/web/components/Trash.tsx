import { RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TrashItem } from '../../shared/schemas.ts';
import { api } from '../lib/api.ts';
import { formatBytes, formatDate } from '../lib/format.ts';
import { useStore } from '../lib/store.tsx';
import { Button, Dialog, Empty, Spinner } from './ui.tsx';

export function Trash() {
  const { trashVersion, fail, toast, state } = useStore();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [confirm, setConfirm] = useState<TrashItem | null>(null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    api.trashList().then((r) => setItems(r.items), fail);
  }, [trashVersion, fail]);
  const days = state?.settings.trashRetentionDays ?? 30;
  const remoteName = (id: string) => state?.remotes.find((r) => r.id === id)?.name ?? '';
  return (
    <section aria-labelledby="trash-h" className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line px-4 py-3">
        <h1 id="trash-h" className="font-semibold">
          Trash
        </h1>
        <p className="text-xs text-muted">Items are deleted permanently after {days} days.</p>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {!items ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty icon={<Trash2 className="size-8" />} title="Trash is empty" />
        ) : (
          <ul aria-label="Trashed items">
            {items.map((t) => {
              const left = Math.max(0, days - Math.floor((now - t.trashedAt) / 86_400_000));
              return (
                <li key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{t.name}</p>
                    <p className="truncate text-xs text-muted">
                      {remoteName(t.remoteId)} · was {t.originalPath} ·{' '}
                      {t.kind === 'file' ? formatBytes(t.size) : 'folder'} · trashed {formatDate(t.trashedAt)}{' '}
                      · {left} day{left === 1 ? '' : 's'} left
                    </p>
                  </div>
                  <Button
                    onClick={() =>
                      api.restore(t.id).then((r) => {
                        toast('success', `Restored to ${r.path}`);
                      }, fail)
                    }
                  >
                    <RotateCcw className="size-4" aria-hidden /> Restore
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirm(t)}
                    aria-label={`Delete ${t.name} forever`}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Dialog open={!!confirm} title="Delete forever?" onClose={() => setConfirm(null)}>
        <p className="text-sm">
          “{confirm?.name}” will be permanently deleted from your storage. This cannot be undone.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              const t = confirm!;
              setConfirm(null);
              api.purge(t.id).then(() => toast('info', `Deleted ${t.name}`), fail);
            }}
          >
            Delete forever
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
