import { Lock } from 'lucide-react';
import { useState } from 'react';
import type { RemoteInfo } from '../../shared/schemas.ts';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.tsx';
import { Button, Field } from './ui.tsx';

export function Unlock({ remote }: { remote: RemoteInfo }) {
  const { refresh, toast } = useStore();
  const [mode, setMode] = useState<'passphrase' | 'recovery'>('passphrase');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-1 items-start justify-center p-6">
      <form
        className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-panel p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.unlock(
              remote.id,
              mode === 'passphrase' ? { passphrase: secret } : { recoveryKey: secret },
            );
            setSecret('');
            await refresh();
            toast('success', `Unlocked ${remote.name}`);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Lock className="size-5 text-accent" aria-hidden />
          <h2 className="font-semibold">{remote.name} is locked</h2>
        </div>
        <p className="text-sm text-muted">
          Its files and names are encrypted. Unlock it to browse, stream and upload. Queued uploads continue
          once it is unlocked.
        </p>
        <Field
          label={mode === 'passphrase' ? 'Passphrase' : 'Recovery key'}
          type={mode === 'passphrase' ? 'password' : 'text'}
          value={secret}
          autoFocus
          autoComplete={mode === 'passphrase' ? 'current-password' : 'off'}
          onChange={(e) => setSecret(e.target.value)}
          error={error}
          placeholder={mode === 'recovery' ? 'XXXX-XXXX-…' : undefined}
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="text-sm text-accent underline-offset-2 hover:underline"
            onClick={() => {
              setMode(mode === 'passphrase' ? 'recovery' : 'passphrase');
              setError(null);
            }}
          >
            {mode === 'passphrase' ? 'Use recovery key instead' : 'Use passphrase instead'}
          </button>
          <Button type="submit" variant="primary" busy={busy} disabled={!secret}>
            Unlock
          </Button>
        </div>
      </form>
    </div>
  );
}
