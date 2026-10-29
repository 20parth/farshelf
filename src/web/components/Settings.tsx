import { useEffect, useState, type ReactNode } from 'react';
import type { RemoteInfo } from '../../shared/schemas.ts';
import { api } from '../lib/api.ts';
import { formatBytes } from '../lib/format.ts';
import { useStore } from '../lib/store.tsx';
import { Button, copyText, Dialog, Field } from './ui.tsx';

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="rounded-2xl border border-line bg-panel p-5">
      <h2 id={`${id}-h`} className="font-semibold">
        {title}
      </h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function NumberSetting({
  label,
  hint,
  value,
  min,
  max,
  onSave,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onSave: (n: number) => void;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v);
  const bad = !Number.isInteger(n) || n < min || n > max;
  return (
    <Field
      label={label}
      type="number"
      min={min}
      max={max}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => !bad && n !== value && onSave(n)}
      error={bad ? `Enter a whole number from ${min} to ${max}` : null}
      hint={hint}
    />
  );
}

export function Settings() {
  const { state, fail, toast, refresh } = useStore();
  if (!state) return null;
  const s = state.settings;
  const save = (patch: Record<string, unknown>) =>
    api.updateSettings(patch).then(() => {
      toast('success', 'Settings saved');
      return refresh();
    }, fail);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 p-4 sm:p-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Section
          id="storage"
          title="Storage"
          description="Each storage location appears as a folder in the sidebar and in your file manager."
        >
          {state.remotes.map((r) => (
            <RemoteRow key={r.id} remote={r} />
          ))}
        </Section>
        <MountSection />
        <AiSection />
        <Section id="general" title="Streaming and uploads">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumberSetting
              label="Streaming cache (MiB)"
              hint="Recently read pieces are kept in memory only, never on disk."
              value={s.cacheLimitMiB}
              min={16}
              max={16384}
              onSave={(n) => save({ cacheLimitMiB: n })}
            />
            <NumberSetting
              label="Read-ahead (MiB)"
              hint="How far ahead to fetch when playing a file. Higher helps on slow links."
              value={s.readAheadBlocks}
              min={0}
              max={32}
              onSave={(n) => save({ readAheadBlocks: n })}
            />
            <NumberSetting
              label="Parallel uploads"
              hint="Files uploaded at the same time."
              value={s.uploadConcurrency}
              min={1}
              max={8}
              onSave={(n) => save({ uploadConcurrency: n })}
            />
            <NumberSetting
              label="Keep trash for (days)"
              hint="Then items are deleted permanently."
              value={s.trashRetentionDays}
              min={1}
              max={365}
              onSave={(n) => save({ trashRetentionDays: n })}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-sunk p-3 text-sm">
            <span>
              Cache in use: {formatBytes(state.cache.bytes)} of {formatBytes(state.cache.limit)} (
              {state.cache.entries} pieces)
            </span>
            <Button
              onClick={() =>
                api.clearCache().then(() => refresh().then(() => toast('success', 'Cache cleared')), fail)
              }
            >
              Clear cache
            </Button>
          </div>
        </Section>
        <Section id="privacy" title="Privacy" description="What stays on this computer and what leaves it.">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>Farshelf has no account, no telemetry, no analytics and no update pings.</li>
            <li>
              File contents travel only between this computer and the storage you added. Nothing goes through
              a Farshelf server, because none exists.
            </li>
            <li>
              The file index, activity history and settings stay in a local database. Sign-ins and keys are
              stored in: <strong>{state.keychain}</strong>
              {state.keychain === 'database' || state.keychain === 'memory'
                ? ' (no OS keychain found; encrypted storage must be unlocked after every restart)'
                : ''}
              .
            </li>
            <li>AI is off unless you turn it on. When on, see the AI section for exactly what is sent.</li>
            <li>
              To remove everything from this computer: stop Farshelf and run <code>farshelf reset --yes</code>
              . Your stored files are not touched.
            </li>
          </ul>
        </Section>
        <p className="pb-6 text-center text-xs text-muted">
          Farshelf {state.version} · Apache-2.0 · free and open source
        </p>
      </div>
    </div>
  );
}

function RemoteRow({ remote }: { remote: RemoteInfo }) {
  const { fail, toast, refresh } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [pass, setPass] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {remote.name}{' '}
          <span className="text-xs font-normal text-muted">
            ({remote.kind}
            {remote.encrypted ? ', encrypted' : ''}
            {remote.locked ? ', locked' : ''})
          </span>
        </p>
        <p className="truncate text-xs text-muted" title={remote.summary}>
          {remote.summary}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            api.index(remote.id).then(() => toast('info', `Re-indexing ${remote.name} for search`), fail)
          }
          disabled={remote.locked}
        >
          Re-index
        </Button>
        {remote.encrypted && !remote.locked && (
          <>
            <Button onClick={() => setPass('')}>Change passphrase</Button>
            <Button onClick={() => api.lock(remote.id).then(refresh, fail)}>Lock</Button>
          </>
        )}
        <Button variant="ghost" className="text-danger" onClick={() => setConfirm(true)}>
          Remove
        </Button>
      </div>
      <Dialog open={confirm} title={`Remove “${remote.name}”?`} onClose={() => setConfirm(false)}>
        <p className="text-sm">
          Farshelf forgets this storage: its sign-in, keys, index and queued uploads on this computer.{' '}
          <strong>Files already in the storage are not deleted.</strong>
          {remote.encrypted && ' You can add it again later with the same passphrase.'}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() =>
              api.removeRemote(remote.id).then(() => {
                setConfirm(false);
                return refresh();
              }, fail)
            }
          >
            Remove
          </Button>
        </div>
      </Dialog>
      <Dialog open={pass !== null} title="Change passphrase" onClose={() => setPass(null)}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            api.changePassphrase(remote.id, pass ?? '').then(() => {
              setPass(null);
              toast('success', 'Passphrase changed. Your recovery key still works.');
            }, fail);
          }}
        >
          <Field
            label="New passphrase"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={pass ?? ''}
            onChange={(e) => setPass(e.target.value)}
            hint="At least 8 characters. Files are not re-encrypted; the master key is re-wrapped."
          />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setPass(null)}>Cancel</Button>
            <Button type="submit" variant="primary">
              Change
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function MountSection() {
  const { state, fail, toast } = useStore();
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const { dav } = state;
  const copy = async (label: string, v: string) =>
    toast((await copyText(v)) ? 'success' : 'error', `${label} copied`);
  return (
    <Section
      id="mount"
      title="Use it in your file manager"
      description="Farshelf serves your storage over WebDAV on this computer only. Any file manager can mount it."
    >
      <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-sm">
        {[
          ['Address', dav.url],
          ['User', dav.username],
          ['Password', dav.password],
        ].map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="truncate font-mono text-xs">{k === 'Password' ? '•'.repeat(12) : v}</dd>
            <dd>
              <Button onClick={() => copy(k!, v!)}>Copy</Button>
            </dd>
          </div>
        ))}
      </dl>
      {state.platform === 'darwin' && (
        <div>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              api
                .mount()
                .then(() => toast('success', 'Mounted. Look for it under Locations in Finder.'), fail)
                .finally(() => setBusy(false));
            }}
          >
            Mount in Finder
          </Button>
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Manual steps for macOS, Windows and Linux</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>macOS: Finder › Go › Connect to Server (⌘K), enter the address, then the user and password.</li>
          <li>
            Windows: File Explorer › This PC › Map network drive › “Connect to a Web site…”, enter the
            address. Large files need a registry change (see Troubleshooting).
          </li>
          <li>
            Linux (GNOME Files / KDE Dolphin): Other Locations › Connect to Server, use <code>dav://</code>{' '}
            instead of <code>http://</code>.
          </li>
        </ul>
        <p className="mt-2 text-xs text-muted">
          Note: some file managers (including Finder) copy a whole file locally when it is opened. For true
          streaming of big media, open files from Farshelf or paste their stream link into VLC or IINA.
        </p>
      </details>
    </Section>
  );
}

function AiSection() {
  const { state, fail, toast, refresh } = useStore();
  const ai = state!.settings.ai;
  const [form, setForm] = useState(ai);
  const [apiKey, setApiKey] = useState('');
  const [test, setTest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(ai), [ai]);
  const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(form.baseUrl);
  return (
    <Section
      id="ai"
      title="AI assistant (optional)"
      description="Ask in plain words to find files or organise a folder. Off by default. Nothing in Farshelf needs it."
    >
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="accent-[var(--color-accent)]"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
        />
        Enable AI features
      </label>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Provider
          <select
            className="rounded-lg border border-line bg-panel px-3 py-2 text-sm font-normal"
            value={form.provider}
            onChange={(e) => {
              const provider = e.target.value as 'ollama' | 'openai';
              setForm({
                ...form,
                provider,
                baseUrl: provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1',
                model: provider === 'ollama' ? 'llama3.2' : 'gpt-4o-mini',
              });
            }}
          >
            <option value="ollama">Ollama (runs on your computer)</option>
            <option value="openai">OpenAI-compatible API (LM Studio, llama.cpp, vLLM, hosted)</option>
          </select>
        </label>
        <Field
          label="Model"
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        />
        <Field
          label="Endpoint URL"
          type="url"
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          hint={
            local
              ? 'Local: requests stay on this computer.'
              : 'Remote: your requests are sent to this server. Hosted providers may charge per use.'
          }
        />
        {form.provider === 'openai' && (
          <Field
            label="API key"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={
              state!.aiKeyStored ? '•••••• stored (leave blank to keep)' : 'Not needed for most local servers'
            }
            onChange={(e) => setApiKey(e.target.value)}
            hint={`Stored in ${state!.keychain}. Never logged or shown again.`}
          />
        )}
      </div>
      <div className="rounded-xl bg-sunk p-3 text-xs text-muted">
        <strong className="text-ink">What is sent:</strong> your question, plus, only if you tick “share
        names” for a request, the names, sizes and dates of items in the current folder. File contents are
        never sent. Names from encrypted storage are never sent. The assistant can only <em>propose</em>{' '}
        creating folders, moving and trashing; you approve every step.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.updateSettings({ ai: form, ...(apiKey ? { aiApiKey: apiKey } : {}) });
              setApiKey('');
              await refresh();
              toast('success', 'AI settings saved');
            } catch (err) {
              fail(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
        <Button
          onClick={async () => {
            setTest('Testing…');
            try {
              await api.updateSettings({ ai: form, ...(apiKey ? { aiApiKey: apiKey } : {}) });
              const r = await api.aiTest();
              setTest(
                r.modelAvailable
                  ? `Connected (${r.location}). Model “${form.model}” is available.`
                  : `Connected, but “${form.model}” was not found. Available: ${r.models.slice(0, 8).join(', ') || 'none'}${form.provider === 'ollama' ? `. Run: ollama pull ${form.model}` : ''}`,
              );
            } catch (err) {
              setTest(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Test connection
        </Button>
        {state!.aiKeyStored && form.provider === 'openai' && (
          <Button variant="ghost" onClick={() => api.updateSettings({ aiApiKey: null }).then(refresh, fail)}>
            Forget API key
          </Button>
        )}
      </div>
      {test && (
        <p role="status" className="text-sm">
          {test}
        </p>
      )}
    </Section>
  );
}
