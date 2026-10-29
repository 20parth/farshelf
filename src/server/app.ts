// The Farshelf service: remotes, file operations, trash, uploads, indexing and settings. HTTP layers call into this.
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import {
  createRemoteInput,
  settingsPatch,
  settingsSchema,
  type CreateRemoteInput,
  type Entry,
  type JobInfo,
  type RemoteInfo,
  type RemoteKind,
  type SearchFilter,
  type Settings,
  type TrashItem,
} from '../shared/schemas.ts';
import { ActivityLog } from './activity.ts';
import { GdriveBackend, GOOGLE, finishOAuth, startOAuth, type GoogleEndpoints, type OAuthFlow } from './backends/gdrive.ts';
import { LocalBackend } from './backends/local.ts';
import type { Backend } from './backends/types.ts';
import { WebdavBackend } from './backends/webdav.ts';
import { BlockCache } from './cache.ts';
import { Catalog } from './catalog.ts';
import { newFile } from './crypto/format.ts';
import { changePassphrase, createVault, unlockWithPassphrase, unlockWithRecoveryKey } from './crypto/keys.ts';
import { openDb, type Db } from './db.ts';
import { AppError, ConflictError, errorMessage, LockedError, NotFoundError } from './errors.ts';
import { JobQueue, type JobContext } from './jobs.ts';
import { baseName, isWithin, joinPath, normPath, parentOf } from './paths.ts';
import { openSecretStore, type SecretStore } from './secrets.ts';
import { TRASH_DIR, Vault, type PendingFile } from './vault.ts';

export const VERSION = '0.1.0';

interface RemoteRow {
  id: string;
  name: string;
  kind: RemoteKind;
  config: string;
  encrypted: number;
  created_at: number;
}

export interface AppOptions {
  dataDir: string;
  /** Public base URL of this daemon, used for OAuth redirects and WebDAV hints. */
  baseUrl: string;
  secrets?: SecretStore;
  google?: GoogleEndpoints;
  /** Override scrypt cost in tests. */
  kdfParams?: { N: number; r: number; p: number };
  backoffMs?: (attempt: number) => number;
}

interface AuthFile {
  apiToken: string;
  davPassword: string;
  streamKey: string;
}

export class App extends EventEmitter {
  readonly db: Db;
  readonly dataDir: string;
  readonly spoolDir: string;
  readonly secrets: SecretStore;
  readonly cache: BlockCache;
  readonly catalog: Catalog;
  readonly activity: ActivityLog;
  readonly jobs: JobQueue;
  readonly auth: AuthFile;
  baseUrl: string;
  private settingsValue: Settings;
  private readonly vaults = new Map<string, Vault>();
  private readonly oauthFlows = new Map<string, OAuthFlow>();
  private readonly google: GoogleEndpoints;
  private readonly kdfParams?: { N: number; r: number; p: number };
  private purgeTimer: NodeJS.Timeout | null = null;

  private constructor(db: Db, opts: AppOptions, secrets: SecretStore, auth: AuthFile) {
    super();
    this.setMaxListeners(100);
    this.db = db;
    this.dataDir = opts.dataDir;
    this.spoolDir = path.join(opts.dataDir, 'spool');
    this.secrets = secrets;
    this.auth = auth;
    this.baseUrl = opts.baseUrl;
    this.google = opts.google ?? GOOGLE;
    this.kdfParams = opts.kdfParams;
    this.settingsValue = this.loadSettings();
    this.cache = new BlockCache(this.settingsValue.cacheLimitMiB * 1024 * 1024);
    this.catalog = new Catalog(db);
    this.activity = new ActivityLog(db);
    this.activity.on('activity', (a) => this.emit('activity', a));
    this.jobs = new JobQueue(
      db,
      {
        upload: { run: (job, ctx) => this.runUpload(job, ctx), cleanup: (job, p) => this.cleanupUpload(job, p) },
        index: { run: (job, ctx) => this.runIndex(job, ctx) },
      },
      {
        concurrency: (kind) => (kind === 'upload' ? this.settingsValue.uploadConcurrency : 1),
        canRun: (job) => {
          const v = this.vaults.get(job.remoteId);
          return !!v && !v.locked;
        },
        backoffMs: opts.backoffMs,
      },
    );
    this.jobs.on('job', (j: JobInfo) => this.emit('job', j));
    this.jobs.on('job-error', (j: JobInfo, err: unknown) =>
      this.activity.add('warn', j.kind, `${j.label}: ${errorMessage(err)}`, { remoteId: j.remoteId, path: j.path }),
    );
  }

  static async open(opts: AppOptions): Promise<App> {
    await fs.mkdir(path.join(opts.dataDir, 'spool'), { recursive: true, mode: 0o700 });
    await fs.chmod(opts.dataDir, 0o700).catch(() => undefined);
    const db = openDb(path.join(opts.dataDir, 'farshelf.db'));
    await fs.chmod(path.join(opts.dataDir, 'farshelf.db'), 0o600).catch(() => undefined);
    const secrets = opts.secrets ?? (await openSecretStore(db));
    const auth = await loadAuth(path.join(opts.dataDir, 'auth.json'));
    const app = new App(db, opts, secrets, auth);
    for (const row of app.rows()) {
      try {
        await app.mountRemote(row);
      } catch (err) {
        app.activity.add('error', 'remote', `Could not open "${row.name}": ${errorMessage(err)}`, { remoteId: row.id });
      }
    }
    const recovered = app.jobs.recover();
    if (recovered) app.activity.add('info', 'recovery', `Resumed ${recovered} interrupted job(s) after restart`);
    return app;
  }

  start(): void {
    this.jobs.start();
    void this.purgeExpiredTrash().catch(() => undefined);
    this.purgeTimer = setInterval(() => void this.purgeExpiredTrash().catch(() => undefined), 3_600_000);
  }

  async close(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.jobs.stop();
    this.db.close();
  }

  // ---------- auth helpers ----------

  checkToken(candidate: string | undefined): boolean {
    return !!candidate && safeEqual(candidate, this.auth.apiToken);
  }

  checkDavPassword(candidate: string | undefined): boolean {
    return !!candidate && safeEqual(candidate, this.auth.davPassword);
  }

  streamSignature(remoteId: string, p: string): string {
    return createHmac('sha256', this.auth.streamKey).update(`${remoteId}\n${normPath(p)}`).digest('base64url').slice(0, 32);
  }

  checkStreamSignature(remoteId: string, p: string, sig: string | null): boolean {
    return !!sig && safeEqual(sig, this.streamSignature(remoteId, p));
  }

  streamUrl(remoteId: string, p: string): string {
    const enc = normPath(p).split('/').map(encodeURIComponent).join('/');
    return `${this.baseUrl}/stream/${remoteId}${enc}?sig=${this.streamSignature(remoteId, p)}`;
  }

  // ---------- settings ----------

  private loadSettings(): Settings {
    const row = this.db.prepare(`select value from settings where key = 'settings'`).get() as { value: string } | undefined;
    const parsed = settingsSchema.safeParse(row ? JSON.parse(row.value) : {});
    return parsed.success ? parsed.data : settingsSchema.parse({});
  }

  get settings(): Settings {
    return this.settingsValue;
  }

  async updateSettings(input: unknown): Promise<Settings> {
    const patch = settingsPatch.parse(input);
    const { aiApiKey, ai, ...rest } = patch;
    const next = settingsSchema.parse({ ...this.settingsValue, ...rest, ai: { ...this.settingsValue.ai, ...ai } });
    this.db
      .prepare(`insert into settings (key, value) values ('settings', ?) on conflict(key) do update set value = excluded.value`)
      .run(JSON.stringify(next));
    if (aiApiKey !== undefined) {
      if (aiApiKey) await this.secrets.set('ai:apiKey', aiApiKey);
      else await this.secrets.delete('ai:apiKey');
    }
    this.settingsValue = next;
    this.cache.setLimit(next.cacheLimitMiB * 1024 * 1024);
    this.emit('state');
    return next;
  }

  async aiApiKey(): Promise<string | null> {
    return (await this.secrets.get('ai:apiKey')) ?? process.env.FARSHELF_AI_API_KEY ?? null;
  }

  // ---------- remotes ----------

  private rows(): RemoteRow[] {
    return this.db.prepare('select * from remotes order by created_at').all() as unknown as RemoteRow[];
  }

  private row(id: string): RemoteRow {
    const r = this.db.prepare('select * from remotes where id = ?').get(id) as RemoteRow | undefined;
    if (!r) throw new NotFoundError('remote');
    return r;
  }

  vault(id: string): Vault {
    const v = this.vaults.get(id);
    if (!v) throw new NotFoundError('remote');
    return v;
  }

  vaultByName(name: string): Vault | undefined {
    return [...this.vaults.values()].find((v) => v.remoteName === name);
  }

  listRemotes(): RemoteInfo[] {
    return this.rows().map((r) => {
      const v = this.vaults.get(r.id);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        encrypted: !!r.encrypted,
        locked: v ? v.locked : true,
        createdAt: r.created_at,
        summary: v ? v.backend.describe() : 'unavailable',
      };
    });
  }

  private async makeBackend(row: { id: string; kind: RemoteKind; config: Record<string, unknown> }): Promise<Backend> {
    const c = row.config;
    if (row.kind === 'local') {
      const b = new LocalBackend(String(c.root));
      await b.init();
      return b;
    }
    if (row.kind === 'webdav') {
      const password = (await this.secrets.get(`remote:${row.id}:password`)) ?? undefined;
      return new WebdavBackend({ url: String(c.url), username: c.username as string | undefined, password });
    }
    const refreshToken = await this.secrets.get(`remote:${row.id}:refresh`);
    if (!refreshToken) throw new AppError(401, 'remote_auth', 'Google sign-in is missing; remove and re-add this remote');
    const clientSecret = (await this.secrets.get(`remote:${row.id}:clientSecret`)) ?? undefined;
    return new GdriveBackend({ clientId: String(c.clientId), clientSecret, refreshToken }, String(c.folderName), this.google);
  }

  private pendingFor(remoteId: string): Map<string, PendingFile> {
    const rows = this.db
      .prepare(`select path, payload from jobs where kind = 'upload' and remote_id = ? and state in ('queued', 'running', 'paused', 'failed')`)
      .all(remoteId) as { path: string; payload: string }[];
    const out = new Map<string, PendingFile>();
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { spoolPath: string; size: number; mtime: number };
      out.set(r.path, { spoolPath: p.spoolPath, size: p.size, mtime: p.mtime });
    }
    return out;
  }

  private async mountRemote(row: RemoteRow): Promise<Vault> {
    const backend = await this.makeBackend({ id: row.id, kind: row.kind, config: JSON.parse(row.config) });
    const vault = new Vault({
      remoteId: row.id,
      remoteName: row.name,
      backend,
      encrypted: !!row.encrypted,
      cache: this.cache,
      readAhead: () => this.settingsValue.readAheadBlocks,
      pending: () => this.pendingFor(row.id),
    });
    if (row.encrypted) {
      const stored = await this.secrets.get(`remote:${row.id}:master`).catch(() => null);
      if (stored) vault.setMasterKey(Buffer.from(stored, 'hex'));
    }
    this.vaults.set(row.id, vault);
    return vault;
  }

  startGoogleSignIn(clientId: string, clientSecret?: string): { flowId: string; authUrl: string } {
    const { flow, authUrl } = startOAuth(clientId, clientSecret, `${this.baseUrl}/oauth/callback`, this.google);
    this.oauthFlows.set(flow.id, flow);
    for (const [id, f] of this.oauthFlows) if (Date.now() - f.createdAt > 15 * 60_000) this.oauthFlows.delete(id);
    return { flowId: flow.id, authUrl };
  }

  /** Handles the browser redirect from Google. Authenticated by the unguessable `state`. */
  async completeGoogleSignIn(state: string, code: string | null, error: string | null): Promise<OAuthFlow> {
    const flow = [...this.oauthFlows.values()].find((f) => safeEqual(f.state, state));
    if (!flow) throw new AppError(400, 'oauth_state', 'This sign-in link is unknown or expired. Start again from Farshelf.');
    if (error || !code) {
      flow.error = error ?? 'no authorisation code';
    } else {
      try {
        flow.result = await finishOAuth(flow, code, this.google);
      } catch (err) {
        flow.error = errorMessage(err);
      }
    }
    this.emit('oauth', { flowId: flow.id, ok: !!flow.result, email: flow.result?.email ?? null, error: flow.error ?? null });
    return flow;
  }

  googleFlowStatus(flowId: string) {
    const f = this.oauthFlows.get(flowId);
    if (!f) throw new NotFoundError('sign-in flow');
    return { done: !!f.result || !!f.error, ok: !!f.result, email: f.result?.email ?? null, error: f.error ?? null };
  }

  async createRemote(raw: unknown): Promise<{ remote: RemoteInfo; recoveryKey: string | null }> {
    const input: CreateRemoteInput = createRemoteInput.parse(raw);
    if (this.rows().some((r) => r.name.toLowerCase() === input.name.toLowerCase())) {
      throw new ConflictError(`a remote called "${input.name}" already exists`);
    }
    const id = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
    const secrets: Record<string, string> = {};
    let config: Record<string, unknown>;
    if (input.kind === 'local') {
      const root = path.resolve(input.config.root.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
      if (isWithin(root, this.dataDir) || isWithin(this.dataDir, root)) {
        throw new AppError(400, 'bad_root', 'choose a folder outside Farshelf’s own data directory');
      }
      config = { root };
    } else if (input.kind === 'webdav') {
      config = { url: input.config.url, username: input.config.username };
      if (input.config.password) secrets.password = input.config.password;
    } else {
      const flow = this.oauthFlows.get(input.config.flowId);
      if (!flow?.result) throw new AppError(400, 'oauth_incomplete', 'finish signing in with Google first');
      config = { clientId: flow.clientId, folderName: input.config.folderName, email: flow.result.email };
      secrets.refresh = flow.result.refreshToken;
      if (flow.clientSecret) secrets.clientSecret = flow.clientSecret;
      this.oauthFlows.delete(flow.id);
    }
    for (const [k, v] of Object.entries(secrets)) await this.secrets.set(`remote:${id}:${k}`, v);

    let recoveryKey: string | null = null;
    let masterKey: Buffer | null = null;
    try {
      const backend = await this.makeBackend({ id, kind: input.kind, config });
      const probe = new Vault({
        remoteId: id,
        remoteName: input.name,
        backend,
        encrypted: false,
        cache: this.cache,
        readAhead: () => 0,
        pending: () => new Map(),
      });
      await backend.list('/').catch((err) => {
        throw new AppError(400, 'remote_unreachable', `cannot open the location: ${errorMessage(err)}`);
      });
      const existing = await probe.readVaultDoc();
      if (existing && !input.passphrase) {
        throw new AppError(400, 'needs_passphrase', 'this location already holds an encrypted Farshelf remote; enter its passphrase');
      }
      if (input.passphrase) {
        if (existing) masterKey = await unlockWithPassphrase(existing, input.passphrase);
        else {
          const created = await createVault(input.passphrase, this.kdfParams);
          await probe.writeVaultDoc(created.doc);
          masterKey = created.masterKey;
          recoveryKey = created.recoveryKey;
        }
      }
    } catch (err) {
      for (const k of Object.keys(secrets)) await this.secrets.delete(`remote:${id}:${k}`);
      throw err;
    }

    this.db
      .prepare('insert into remotes (id, name, kind, config, encrypted, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.kind, JSON.stringify(config), masterKey ? 1 : 0, Date.now());
    const vault = await this.mountRemote(this.row(id));
    if (masterKey) {
      vault.setMasterKey(masterKey);
      if (this.secrets.secure) await this.secrets.set(`remote:${id}:master`, masterKey.toString('hex'));
    }
    this.activity.add('info', 'remote', `Added ${input.kind} remote "${input.name}"${masterKey ? ' (encrypted)' : ''}`, { remoteId: id });
    this.indexRemote(id);
    this.emit('state');
    return { remote: this.listRemotes().find((r) => r.id === id)!, recoveryKey };
  }

  async removeRemote(id: string): Promise<void> {
    const row = this.row(id);
    this.jobs.deleteForRemote(id);
    for (const k of ['password', 'refresh', 'clientSecret', 'master']) await this.secrets.delete(`remote:${id}:${k}`);
    this.cache.invalidate(`${id}:`);
    this.db.prepare('delete from remotes where id = ?').run(id);
    this.vaults.delete(id);
    this.activity.add('info', 'remote', `Removed remote "${row.name}". Its files were left untouched.`);
    this.emit('state');
  }

  async unlock(id: string, input: { passphrase: string } | { recoveryKey: string }): Promise<void> {
    const vault = this.vault(id);
    if (!vault.encrypted) return;
    const doc = await vault.readVaultDoc();
    if (!doc) throw new AppError(500, 'vault_missing', 'the encryption key file (.farshelf/vault.json) is missing from this remote');
    const key = 'passphrase' in input ? await unlockWithPassphrase(doc, input.passphrase) : unlockWithRecoveryKey(doc, input.recoveryKey);
    vault.setMasterKey(key);
    if (this.secrets.secure) await this.secrets.set(`remote:${id}:master`, key.toString('hex'));
    this.activity.add('info', 'unlock', `Unlocked "${vault.remoteName}"`, { remoteId: id });
    this.emit('state');
    void this.jobs.tick();
  }

  async lock(id: string): Promise<void> {
    const vault = this.vault(id);
    vault.setMasterKey(null);
    await this.secrets.delete(`remote:${id}:master`);
    this.activity.add('info', 'lock', `Locked "${vault.remoteName}"`, { remoteId: id });
    this.emit('state');
  }

  async changePassphrase(id: string, passphrase: string): Promise<void> {
    const vault = this.vault(id);
    const doc = await vault.readVaultDoc();
    if (!doc) throw new AppError(400, 'not_encrypted', 'this remote is not encrypted');
    await vault.writeVaultDoc(await changePassphrase(doc, vault.getMasterKey(), passphrase));
    this.activity.add('info', 'passphrase', `Changed the passphrase of "${vault.remoteName}"`, { remoteId: id });
  }

  // ---------- files ----------

  private changed(remoteId: string, dir: string): void {
    this.emit('changed', { remoteId, path: normPath(dir) });
  }

  async list(remoteId: string, dir: string): Promise<Entry[]> {
    const vault = this.vault(remoteId);
    const entries = await vault.list(dir);
    this.catalog.putListing(remoteId, dir, entries);
    return entries;
  }

  async mkdir(remoteId: string, p: string, source: 'user' | 'ai' = 'user'): Promise<void> {
    const vault = this.vault(remoteId);
    guardUserPath(p);
    if (await vault.stat(p)) throw new ConflictError(`${baseName(p)} already exists`);
    await vault.mkdir(p);
    this.catalog.upsert(remoteId, { path: p, name: baseName(p), kind: 'dir', size: 0, mtime: Date.now() });
    this.activity.add('info', 'mkdir', `Created folder ${p}${source === 'ai' ? ' (AI plan, approved)' : ''}`, { remoteId, path: p });
    this.changed(remoteId, parentOf(p));
  }

  async move(remoteId: string, from: string, to: string, source: 'user' | 'ai' = 'user'): Promise<void> {
    const vault = this.vault(remoteId);
    guardUserPath(from);
    guardUserPath(to);
    if (normPath(from) === normPath(to)) return;
    if (isWithin(to, from)) throw new AppError(400, 'bad_move', 'cannot move a folder into itself');
    if (this.pendingFor(remoteId).has(normPath(from))) throw new ConflictError('wait for the upload to finish before moving this file');
    if (!(await vault.stat(from))) throw new NotFoundError(from);
    if (await vault.stat(to)) throw new ConflictError(`${to} already exists`);
    if (vault.encrypted) await vault.mkdir(parentOf(to));
    await vault.move(from, to);
    this.catalog.moveTree(remoteId, from, to);
    this.activity.add('info', 'move', `Moved ${from} → ${to}${source === 'ai' ? ' (AI plan, approved)' : ''}`, { remoteId, path: to });
    this.changed(remoteId, parentOf(from));
    this.changed(remoteId, parentOf(to));
  }

  async trash(remoteId: string, p: string, source: 'user' | 'ai' = 'user'): Promise<TrashItem> {
    const vault = this.vault(remoteId);
    guardUserPath(p);
    const n = normPath(p);
    const pendingJob = this.jobs.list({ remoteId, states: ['queued', 'running', 'paused', 'failed'] }).find((j) => j.kind === 'upload' && j.path === n);
    if (pendingJob) {
      await this.jobs.cancel(pendingJob.id);
      this.changed(remoteId, parentOf(n));
      return { id: '', remoteId, originalPath: n, name: baseName(n), kind: 'file', size: 0, trashedAt: Date.now() };
    }
    const st = await vault.stat(n);
    if (!st) throw new NotFoundError(n);
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    await vault.backend.mkdir(`${TRASH_DIR}/${id}`);
    await vault.backend.move(vault.remotePath(n), vault.trashPath(id, st.name));
    vault.invalidate(n);
    const item: TrashItem = { id, remoteId, originalPath: n, name: st.name, kind: st.kind, size: st.size, trashedAt: Date.now() };
    this.db
      .prepare('insert into trash (id, remote_id, original_path, name, kind, size, trashed_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, remoteId, n, st.name, st.kind, st.size, item.trashedAt);
    this.catalog.removeTree(remoteId, n);
    this.activity.add('info', 'trash', `Moved ${n} to trash${source === 'ai' ? ' (AI plan, approved)' : ''}`, { remoteId, path: n });
    this.changed(remoteId, parentOf(n));
    this.emit('trash');
    return item;
  }

  listTrash(remoteId?: string): TrashItem[] {
    const cols = 'id, remote_id as remoteId, original_path as originalPath, name, kind, size, trashed_at as trashedAt';
    return (remoteId
      ? this.db.prepare(`select ${cols} from trash where remote_id = ? order by trashed_at desc`).all(remoteId)
      : this.db.prepare(`select ${cols} from trash order by trashed_at desc`).all()) as unknown as TrashItem[];
  }

  private trashItem(id: string): TrashItem {
    const item = this.listTrash().find((t) => t.id === id);
    if (!item) throw new NotFoundError('trash item');
    return item;
  }

  async restore(trashId: string): Promise<string> {
    const item = this.trashItem(trashId);
    const vault = this.vault(item.remoteId);
    let target = item.originalPath;
    for (let i = 1; await vault.stat(target); i++) target = withSuffix(item.originalPath, i);
    await vault.mkdir(parentOf(target)).catch(() => undefined);
    await vault.backend.move(vault.trashPath(item.id, item.name), vault.remotePath(target));
    await vault.backend.remove(`${TRASH_DIR}/${item.id}`).catch(() => undefined);
    vault.invalidate(target);
    this.db.prepare('delete from trash where id = ?').run(trashId);
    this.activity.add('info', 'restore', `Restored ${target} from trash`, { remoteId: item.remoteId, path: target });
    this.changed(item.remoteId, parentOf(target));
    this.emit('trash');
    return target;
  }

  /** Permanently delete one trash item. This cannot be undone. */
  async purge(trashId: string): Promise<void> {
    const item = this.trashItem(trashId);
    const vault = this.vault(item.remoteId);
    await vault.backend.remove(`${TRASH_DIR}/${item.id}`);
    this.db.prepare('delete from trash where id = ?').run(trashId);
    this.activity.add('info', 'purge', `Permanently deleted ${item.originalPath}`, { remoteId: item.remoteId, path: item.originalPath });
    this.emit('trash');
  }

  async purgeExpiredTrash(now = Date.now()): Promise<number> {
    const cutoff = now - this.settingsValue.trashRetentionDays * 86_400_000;
    const old = this.listTrash().filter((t) => t.trashedAt < cutoff);
    let n = 0;
    for (const t of old) {
      try {
        await this.purge(t.id);
        n++;
      } catch {
        // remote offline or locked; try again next hour
      }
    }
    return n;
  }

  // ---------- uploads ----------

  /** Write an incoming body to the spool, then queue the upload. Returns once the data is safely on local disk. */
  async receiveUpload(
    remoteId: string,
    target: string,
    body: Readable,
    opts: { expectedSize?: number; autoRename?: boolean; mtime?: number } = {},
  ): Promise<JobInfo> {
    const vault = this.vault(remoteId);
    if (vault.locked) throw new LockedError(vault.remoteName);
    guardUserPath(target);
    let finalPath = normPath(target);
    const pending = this.pendingFor(remoteId);
    if (opts.autoRename) {
      for (let i = 1; pending.has(finalPath) || (await vault.stat(finalPath)); i++) finalPath = withSuffix(normPath(target), i);
    } else {
      const existing = await vault.stat(finalPath);
      if (existing?.kind === 'dir') throw new ConflictError(`${finalPath} is a folder`);
      // Overwrite: cancel an older pending upload for the same path.
      for (const j of this.jobs.list({ remoteId, states: ['queued', 'running', 'paused', 'failed'] })) {
        if (j.kind === 'upload' && j.path === finalPath) await this.jobs.cancel(j.id);
      }
    }
    const spoolPath = path.join(this.spoolDir, randomUUID());
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(spoolPath, { mode: 0o600 }));
      if (opts.expectedSize !== undefined && size !== opts.expectedSize) {
        throw new AppError(400, 'incomplete_upload', `received ${size} of ${opts.expectedSize} bytes`);
      }
    } catch (err) {
      await fs.rm(spoolPath, { force: true });
      throw err;
    }
    return this.enqueueUpload(remoteId, finalPath, spoolPath, size, opts.mtime ?? Date.now());
  }

  enqueueUpload(remoteId: string, target: string, spoolPath: string, size: number, mtime: number): JobInfo {
    const vault = this.vault(remoteId);
    const header = vault.encrypted ? newFile(vault.getMasterKey()).header.toString('base64') : null;
    const job = this.jobs.create('upload', remoteId, baseName(target), normPath(target), { spoolPath, size, mtime, header, state: null }, vault.storedSize(size));
    if (this.settingsValue.lastUploadRemoteId !== remoteId) void this.updateSettings({ lastUploadRemoteId: remoteId });
    this.changed(remoteId, parentOf(target));
    return job;
  }

  private async runUpload(job: JobInfo, ctx: JobContext): Promise<void> {
    const vault = this.vault(job.remoteId);
    const p = ctx.payload as { spoolPath: string; size: number; mtime: number; header: string | null; state: Record<string, unknown> | null };
    const backend = vault.backend;
    const stored = vault.storedSize(p.size);
    const remotePath = vault.remotePath(job.path);
    const read = vault.uploadReader(p.spoolPath, p.size, p.header ? Buffer.from(p.header, 'base64') : null);
    if (vault.encrypted) await vault.mkdir(parentOf(job.path));

    if (backend.resumable) {
      let state = p.state;
      let offset = 0;
      if (state) {
        try {
          offset = await backend.uploadedOffset(state);
        } catch (err) {
          if ((err as AppError).code !== 'upload_expired') throw err;
          state = null;
        }
      }
      if (!state) {
        state = await backend.beginUpload(remotePath, stored);
        ctx.savePayload({ ...p, state });
        offset = 0;
      }
      ctx.progress(offset, stored);
      const chunk = backend.chunkSize;
      while (offset < stored || stored === 0) {
        if (ctx.signal.aborted) return;
        const end = Math.min(stored, offset + chunk);
        const data = await read(offset, end);
        await backend.uploadChunk(state, offset, data, ctx.signal);
        offset = end;
        ctx.progress(offset, stored);
        if (stored === 0) break;
      }
    } else {
      let sent = 0;
      const piece = 4 * 1024 * 1024;
      async function* body() {
        for (let o = 0; o < stored; o += piece) {
          const data = await read(o, Math.min(stored, o + piece));
          yield data;
          sent += data.length;
          ctx.progress(sent, stored);
        }
      }
      await backend.putStream!(remotePath, stored, body(), ctx.signal);
      ctx.savePayload({ ...p, state: { path: remotePath, size: stored, finished: true } });
    }
    if (ctx.signal.aborted) return;
    await fs.rm(p.spoolPath, { force: true });
    vault.invalidate(job.path);
    this.catalog.upsert(job.remoteId, { path: job.path, name: baseName(job.path), kind: 'file', size: p.size, mtime: Date.now() });
    this.activity.add('info', 'upload', `Uploaded ${job.path} (${formatBytes(p.size)})`, { remoteId: job.remoteId, path: job.path });
    queueMicrotask(() => this.changed(job.remoteId, parentOf(job.path)));
  }

  private async cleanupUpload(job: JobInfo, payload: Record<string, unknown>): Promise<void> {
    await fs.rm(String(payload.spoolPath), { force: true });
    const vault = this.vaults.get(job.remoteId);
    if (vault && payload.state) await vault.backend.abortUpload(payload.state as Record<string, unknown>).catch(() => undefined);
    this.activity.add('info', 'upload', `Cancelled upload of ${job.path}`, { remoteId: job.remoteId, path: job.path });
    this.changed(job.remoteId, parentOf(job.path));
  }

  // ---------- indexing & search ----------

  indexRemote(remoteId: string, root = '/'): JobInfo {
    const existing = this.jobs.list({ remoteId, states: ['queued', 'running'] }).find((j) => j.kind === 'index');
    if (existing) return existing;
    const vault = this.vault(remoteId);
    return this.jobs.create('index', remoteId, `Index ${vault.remoteName}`, normPath(root), { root: normPath(root) });
  }

  private async runIndex(job: JobInfo, ctx: JobContext): Promise<void> {
    const queue = [String(ctx.payload.root ?? '/')];
    let dirs = 0;
    let files = 0;
    while (queue.length) {
      if (ctx.signal.aborted) return;
      const dir = queue.shift()!;
      const entries = await this.list(job.remoteId, dir);
      dirs++;
      for (const e of entries) {
        if (e.kind === 'dir') queue.push(e.path);
        else files++;
      }
      ctx.progress(dirs, dirs + queue.length);
    }
    this.activity.add('info', 'index', `Indexed ${files} files in ${dirs} folders`, { remoteId: job.remoteId });
  }

  search(filter: SearchFilter) {
    return this.catalog.search(filter);
  }
}

// ---------- helpers ----------

function guardUserPath(p: string): void {
  const n = normPath(p);
  if (n === '/') throw new AppError(400, 'bad_path', 'that operation is not allowed on the root folder');
  const first = n.split('/')[1] ?? '';
  if (first.startsWith('.farshelf')) throw new AppError(400, 'bad_path', 'that path is reserved for Farshelf');
}

export function withSuffix(p: string, i: number): string {
  const dir = parentOf(p);
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return joinPath(dir, `${stem} (${i})${ext}`);
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function loadAuth(file: string): Promise<AuthFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as AuthFile;
    if (parsed.apiToken && parsed.davPassword && parsed.streamKey) return parsed;
  } catch {
    // create below
  }
  const auth: AuthFile = {
    apiToken: randomBytes(32).toString('base64url'),
    davPassword: randomBytes(18).toString('base64url'),
    streamKey: randomBytes(32).toString('base64url'),
  };
  await fs.writeFile(file, JSON.stringify(auth, null, 2), { mode: 0o600 });
  return auth;
}
