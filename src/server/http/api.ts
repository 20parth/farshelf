// JSON API used by the web UI. Every request here has already passed host, origin and session checks.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { z } from 'zod';
import {
  aiPlanInput,
  aiSearchInput,
  moveInput,
  pathInput,
  remotePath,
  searchFilter,
  unlockInput,
  type AppState,
} from '../../shared/schemas.ts';
import { aiPlanSteps, aiSearchFilter, makeProvider } from '../ai/assistant.ts';
import { VERSION, type App } from '../app.ts';
import { AppError, NotFoundError } from '../errors.ts';
import { DAV_PREFIX } from './dav.ts';
import { readJson, sendJson, type Req, type Res } from './util.ts';

type Handler = (ctx: { app: App; req: Req; res: Res; url: URL; params: string[] }) => Promise<unknown>;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
const on = (method: string, pattern: string, handler: Handler) =>
  routes.push({ method, pattern: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), handler });

const query = (url: URL, key: string) => url.searchParams.get(key) ?? undefined;
const pathParam = (url: URL) => remotePath.parse(url.searchParams.get('path') ?? '/');

export function appState(app: App, aiKeyStored: boolean): AppState {
  return {
    version: VERSION,
    remotes: app.listRemotes(),
    settings: app.settings,
    aiKeyStored,
    dav: { url: `${app.baseUrl}${DAV_PREFIX}/`, username: 'farshelf', password: app.auth.davPassword },
    cache: app.cache.stats(),
    platform: process.platform,
    keychain: app.secrets.kind,
  };
}

on('GET', '/api/state', async ({ app }) => appState(app, !!(await app.aiApiKey())));

// ---- remotes ----
on('POST', '/api/remotes', async ({ app, req }) => app.createRemote(await readJson(req, z.unknown())));
on('DELETE', '/api/remotes/:id', async ({ app, params }) => {
  await app.removeRemote(params[0]!);
  return { ok: true };
});
on('POST', '/api/remotes/:id/unlock', async ({ app, req, params }) => {
  await app.unlock(params[0]!, await readJson(req, unlockInput));
  return { ok: true };
});
on('POST', '/api/remotes/:id/lock', async ({ app, params }) => {
  await app.lock(params[0]!);
  return { ok: true };
});
on('POST', '/api/remotes/:id/passphrase', async ({ app, req, params }) => {
  const { passphrase } = await readJson(req, z.object({ passphrase: z.string().min(8) }));
  await app.changePassphrase(params[0]!, passphrase);
  return { ok: true };
});
on('POST', '/api/remotes/:id/index', async ({ app, params }) => app.indexRemote(params[0]!));

// ---- files ----
on('GET', '/api/remotes/:id/list', async ({ app, url, params }) => {
  const entries = await app.list(params[0]!, pathParam(url));
  return { entries };
});
on('GET', '/api/remotes/:id/link', async ({ app, url, params }) => ({ url: app.streamUrl(params[0]!, pathParam(url)) }));
on('POST', '/api/remotes/:id/mkdir', async ({ app, req, params }) => {
  const { path, source } = await readJson(req, pathInput);
  await app.mkdir(params[0]!, path, source);
  return { ok: true };
});
on('POST', '/api/remotes/:id/move', async ({ app, req, params }) => {
  const { from, to, source } = await readJson(req, moveInput);
  await app.move(params[0]!, from, to, source);
  return { ok: true };
});
on('POST', '/api/remotes/:id/trash', async ({ app, req, params }) => {
  const { path, source } = await readJson(req, pathInput);
  return app.trash(params[0]!, path, source);
});
on('PUT', '/api/remotes/:id/upload', async ({ app, req, url, params }) => {
  const length = req.headers['content-length'];
  const mtime = Number(query(url, 'mtime'));
  return app.receiveUpload(params[0]!, pathParam(url), req, {
    expectedSize: length !== undefined ? Number(length) : undefined,
    autoRename: query(url, 'overwrite') !== '1',
    mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : undefined,
  });
});

// ---- trash ----
on('GET', '/api/trash', async ({ app, url }) => ({ items: app.listTrash(query(url, 'remoteId')) }));
on('POST', '/api/trash/:id/restore', async ({ app, params }) => ({ path: await app.restore(params[0]!) }));
on('DELETE', '/api/trash/:id', async ({ app, params }) => {
  await app.purge(params[0]!);
  return { ok: true };
});

// ---- jobs ----
on('GET', '/api/jobs', async ({ app }) => ({ jobs: app.jobs.list() }));
on('POST', '/api/jobs/clear', async ({ app }) => ({ removed: app.jobs.clearFinished() }));
on('POST', '/api/jobs/:id/:action', async ({ app, params }) => {
  const [id, action] = params as [string, string];
  if (action === 'pause') return app.jobs.pause(id);
  if (action === 'resume') return app.jobs.resume(id);
  if (action === 'retry') return app.jobs.retry(id);
  if (action === 'cancel') return app.jobs.cancel(id);
  throw new NotFoundError('job action');
});

// ---- search & activity ----
on('POST', '/api/search', async ({ app, req }) => ({ results: app.search(await readJson(req, searchFilter)) }));
on('GET', '/api/activity', async ({ app, url }) => ({ items: app.activity.list(query(url, 'q')) }));

// ---- settings & maintenance ----
on('PATCH', '/api/settings', async ({ app, req }) => app.updateSettings(await readJson(req, z.unknown())));
on('POST', '/api/cache/clear', async ({ app }) => {
  app.cache.clear();
  app.activity.add('info', 'cache', 'Cleared the streaming cache');
  return app.cache.stats();
});
on('POST', '/api/mount', async ({ app }) => {
  if (process.platform !== 'darwin') throw new AppError(400, 'unsupported', 'automatic mounting is only available on macOS; see the instructions in Settings');
  const url = `${app.baseUrl}${DAV_PREFIX}/`;
  // Script goes to osascript on stdin so the password is not visible in the process list.
  const script = `mount volume "${url}" as user name "farshelf" with password "${app.auth.davPassword}"`;
  const code = await new Promise<number>((resolve) => {
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? -1));
    child.stdin.end(script);
  });
  if (code !== 0) throw new AppError(502, 'mount_failed', 'macOS could not mount the drive. Try Finder › Go › Connect to Server with the address shown.');
  app.activity.add('info', 'mount', `Mounted ${url} in Finder`);
  return { ok: true };
});

// ---- Google sign-in ----
on('POST', '/api/oauth/google/start', async ({ app, req }) => {
  const body = await readJson(req, z.object({ clientId: z.string().min(10).optional(), clientSecret: z.string().optional() }));
  const clientId = body.clientId ?? process.env.FARSHELF_GDRIVE_CLIENT_ID;
  if (!clientId) throw new AppError(400, 'no_client_id', 'enter your Google OAuth client ID (see docs/AI_AND_PROVIDERS.md)');
  return app.startGoogleSignIn(clientId, body.clientSecret || process.env.FARSHELF_GDRIVE_CLIENT_SECRET);
});
on('GET', '/api/oauth/google/:flow', async ({ app, params }) => app.googleFlowStatus(params[0]!));

// ---- AI (optional) ----
async function provider(app: App) {
  const s = app.settings.ai;
  if (!s.enabled) throw new AppError(400, 'ai_disabled', 'AI features are turned off. Enable them in Settings › AI.');
  return makeProvider(s, await app.aiApiKey());
}
on('POST', '/api/ai/test', async ({ app }) => {
  const s = app.settings.ai;
  const models = await makeProvider(s, await app.aiApiKey()).models();
  return {
    ok: true,
    models,
    modelAvailable: models.some((m) => m === s.model || m.split(':')[0] === s.model),
    location: isLocalUrl(s.baseUrl) ? 'local' : 'remote',
  };
});
on('POST', '/api/ai/search', async ({ app, req }) => {
  const { question } = await readJson(req, aiSearchInput);
  const filter = await aiSearchFilter(await provider(app), question);
  app.activity.add('info', 'ai', `AI search: "${question}"`);
  return { filter, results: app.search(filter) };
});
on('POST', '/api/ai/plan', async ({ app, req }) => {
  const input = await readJson(req, aiPlanInput);
  const vault = app.vault(input.remoteId);
  const share = input.shareNames && !vault.encrypted;
  const entries = share
    ? (await app.list(input.remoteId, input.cwd)).slice(0, 300).map((e) => ({
        name: e.name,
        kind: e.kind,
        size: e.size,
        modified: new Date(e.mtime).toISOString().slice(0, 10),
      }))
    : null;
  const plan = await aiPlanSteps(await provider(app), input.request, { cwd: input.cwd, entries });
  app.activity.add('info', 'ai', `AI proposed ${plan.steps.length} step(s) for: "${input.request}"`, { remoteId: input.remoteId });
  return { plan, sharedNames: share, encryptedWithheld: input.shareNames && vault.encrypted };
});

function isLocalUrl(u: string): boolean {
  const host = new URL(u).hostname;
  return ['localhost', '127.0.0.1', '::1', '[::1]', os.hostname()].includes(host) || host.endsWith('.local');
}

export async function handleApi(app: App, req: Req, res: Res, url: URL): Promise<boolean> {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    const out = await r.handler({ app, req, res, url, params: m.slice(1).map(decodeURIComponent) });
    if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
    return true;
  }
  return false;
}
