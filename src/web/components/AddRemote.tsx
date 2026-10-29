import { Cloud, FolderOpen, Globe, Lock } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { RemoteInfo, RemoteKind } from '../../shared/schemas.ts';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.tsx';
import { Button, copyText, Field } from './ui.tsx';

const KINDS: { kind: RemoteKind; label: string; help: string; icon: typeof Cloud; defaultName: string }[] = [
  {
    kind: 'local',
    label: 'Folder on this computer',
    help: 'An external disk, NAS mount or any folder. Fastest way to try Farshelf.',
    icon: FolderOpen,
    defaultName: 'My Files',
  },
  {
    kind: 'webdav',
    label: 'WebDAV / Nextcloud',
    help: 'Nextcloud, ownCloud, a NAS or any WebDAV server you run.',
    icon: Globe,
    defaultName: 'Nextcloud',
  },
  {
    kind: 'gdrive',
    label: 'Google Drive',
    help: 'Uses your existing Google storage. Farshelf only sees files it creates.',
    icon: Cloud,
    defaultName: 'Google Drive',
  },
];

export function AddRemote({
  onDone,
  onCancel,
}: {
  onDone: (remote: RemoteInfo) => void;
  onCancel?: () => void;
}) {
  const { fail, refresh } = useStore();
  const [kind, setKind] = useState<RemoteKind>('local');
  const [name, setName] = useState('My Files');
  const [nameTouched, setNameTouched] = useState(false);
  const [root, setRoot] = useState('~/Farshelf Storage');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [folderName, setFolderName] = useState('Farshelf');
  const [flow, setFlow] = useState<{
    id: string;
    done: boolean;
    ok: boolean;
    email: string | null;
    error: string | null;
  } | null>(null);
  const [encrypt, setEncrypt] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ remote: RemoteInfo; recoveryKey: string } | null>(null);

  useEffect(() => {
    if (!nameTouched) setName(KINDS.find((k) => k.kind === kind)!.defaultName);
  }, [kind, nameTouched]);

  // Poll the Google sign-in started in another tab.
  useEffect(() => {
    if (!flow || flow.done) return;
    const t = setInterval(async () => {
      try {
        const s = await api.googleStatus(flow.id);
        if (s.done) setFlow({ id: flow.id, ...s });
      } catch (err) {
        fail(err);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [flow, fail]);

  const passError =
    encrypt && pass.length > 0 && pass.length < 8
      ? 'Use at least 8 characters'
      : encrypt && pass2 && pass !== pass2
        ? 'Passphrases do not match'
        : null;

  async function signInGoogle() {
    try {
      const { flowId, authUrl } = await api.googleStart(clientId, clientSecret);
      setFlow({ id: flowId, done: false, ok: false, email: null, error: null });
      window.open(authUrl, '_blank', 'noopener');
    } catch (err) {
      fail(err);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (encrypt && (pass.length < 8 || pass !== pass2)) {
      setError(passError ?? 'Enter and confirm a passphrase');
      return;
    }
    const config =
      kind === 'local'
        ? { root }
        : kind === 'webdav'
          ? { url, username: username || undefined, password: password || undefined }
          : { flowId: flow?.id ?? '', folderName };
    setBusy(true);
    try {
      const out = await api.createRemote({ kind, name, config, passphrase: encrypt ? pass : undefined });
      // Refreshing app state may swap onboarding for the main view, so wait until the recovery key is acknowledged.
      if (out.recoveryKey) setCreated({ remote: out.remote, recoveryKey: out.recoveryKey });
      else {
        await refresh();
        onDone(out.remote);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (created)
    return (
      <RecoveryKeyStep
        recoveryKey={created.recoveryKey}
        onContinue={() => void refresh().then(() => onDone(created.remote))}
      />
    );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Add storage">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Where should your files live?</legend>
        {KINDS.map((k) => (
          <label
            key={k.kind}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${kind === k.kind ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-sunk'}`}
          >
            <input
              type="radio"
              name="kind"
              value={k.kind}
              checked={kind === k.kind}
              onChange={() => setKind(k.kind)}
              className="mt-1 accent-[var(--color-accent)]"
            />
            <k.icon className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            <span>
              <span className="block text-sm font-medium">{k.label}</span>
              <span className="block text-xs text-muted">{k.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <Field
        label="Name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNameTouched(true);
        }}
        required
        maxLength={64}
        hint="Shown in the sidebar and as the folder name when mounted."
      />

      {kind === 'local' && (
        <Field
          label="Folder path"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          required
          hint="Created if it does not exist. ~ means your home folder."
        />
      )}

      {kind === 'webdav' && (
        <>
          <Field
            label="Server URL"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            placeholder="https://cloud.example.com/remote.php/dav/files/me/"
            hint="For Nextcloud: Files › Settings › WebDAV shows this address."
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
            <Field
              label="Password or app token"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              hint="Stored in your OS keychain when available."
            />
          </div>
        </>
      )}

      {kind === 'gdrive' && (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-sunk p-3">
          <p className="text-xs text-muted">
            Farshelf has no central server, so you use your own Google OAuth client (“Desktop app” type). It
            takes about 5 minutes; see <code>docs/AI_AND_PROVIDERS.md</code>. Leave these blank if they are
            set with environment variables.
          </p>
          <Field
            label="OAuth client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234-abc.apps.googleusercontent.com"
          />
          <Field
            label="OAuth client secret (Desktop clients)"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
          />
          <Field
            label="Folder in your Drive"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button onClick={signInGoogle} disabled={flow?.ok}>
              {flow?.ok ? 'Signed in' : 'Sign in with Google'}
            </Button>
            <span className="text-sm text-muted" role="status">
              {flow && !flow.done && 'Waiting for you to finish in the browser tab…'}
              {flow?.ok && `Connected as ${flow.email ?? 'your account'}`}
              {flow?.error && <span className="text-danger">{flow.error}</span>}
            </span>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-line p-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={encrypt}
            onChange={(e) => setEncrypt(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          <Lock className="size-4 text-accent" aria-hidden /> Encrypt file contents and names
        </label>
        <p className="mt-1 text-xs text-muted">
          The storage only ever sees scrambled bytes. If you lose both the passphrase and the recovery key,
          nobody can recover the files.
        </p>
        {encrypt && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Passphrase"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
            <Field
              label="Confirm passphrase"
              type="password"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              autoComplete="new-password"
              required
              error={passError}
            />
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" busy={busy} disabled={kind === 'gdrive' && !flow?.ok}>
          Add storage
        </Button>
      </div>
    </form>
  );
}

function RecoveryKeyStep({ recoveryKey, onContinue }: { recoveryKey: string; onContinue: () => void }) {
  const [saved, setSaved] = useState(false);
  const { toast } = useStore();
  const download = () => {
    const blob = new Blob(
      [
        `Farshelf recovery key\n\n${recoveryKey}\n\nKeep this somewhere safe and offline. It unlocks your encrypted files if you forget your passphrase.\n`,
      ],
      { type: 'text/plain' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'farshelf-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-semibold">Save your recovery key</h3>
        <p className="text-sm text-muted">
          This is the only way back in if you forget your passphrase. Farshelf cannot show it again and no one
          can reset it.
        </p>
      </div>
      <p
        className="rounded-xl border border-amber bg-amber-soft p-3 text-center font-mono text-sm break-all select-all"
        data-testid="recovery-key"
      >
        {recoveryKey}
      </p>
      <div className="flex gap-2">
        <Button
          onClick={async () => {
            const ok = await copyText(recoveryKey);
            toast(
              ok ? 'success' : 'error',
              ok ? 'Recovery key copied' : 'Copy failed: select the text instead',
            );
          }}
        >
          Copy
        </Button>
        <Button onClick={download}>Download as .txt</Button>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="accent-[var(--color-accent)]"
        />
        I have saved my recovery key somewhere safe
      </label>
      <div className="flex justify-end">
        <Button variant="primary" disabled={!saved} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
