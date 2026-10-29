import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { App } from '../app.ts';
import { appState, handleApi } from './api.ts';
import { DAV_PREFIX, handleDav } from './dav.ts';
import { handleStream } from './stream.ts';
import { basicAuth, handleError, mimeType, parseCookies, readJson, sendJson, type Req, type Res } from './util.ts';

const COOKIE = 'farshelf_session';
const here = path.dirname(fileURLToPath(import.meta.url));

export function findWebRoot(): string | null {
  for (const c of [path.resolve(here, '../../../web'), path.resolve(here, '../../../dist/web')]) {
    if (existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

export interface ServerOptions {
  /** Extra Host header values to accept (e.g. a reverse-proxy name). */
  extraHosts?: string[];
  /** Extra origins allowed to call the API (e.g. the Vite dev server). */
  extraOrigins?: string[];
  webRoot?: string | null;
}

export function createServer(app: App, opts: ServerOptions = {}): http.Server {
  const webRoot = opts.webRoot === undefined ? findWebRoot() : opts.webRoot;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => handleError(res, err));
  });
  server.requestTimeout = 0; // long uploads and streams
  server.headersTimeout = 60_000;

  const allowedHosts = (): Set<string> => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const extraOriginHosts = (opts.extraOrigins ?? []).map((o) => new URL(o).host);
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(opts.extraHosts ?? []), ...extraOriginHosts]);
  };

  async function handle(req: Req, res: Res): Promise<void> {
    const host = req.headers.host ?? '';
    // DNS-rebinding protection: only answer to names we expect.
    if (!allowedHosts().has(host)) {
      res.writeHead(421, { 'content-type': 'text/plain' });
      res.end('Misdirected request: unknown Host header');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');

    const cookies = parseCookies(req.headers.cookie);
    const hasSession = app.checkToken(cookies[COOKIE]);
    const basic = basicAuth(req.headers.authorization);
    const hasBasic = !!basic && basic.user === 'farshelf' && app.checkDavPassword(basic.pass);

    if (url.pathname === DAV_PREFIX || url.pathname.startsWith(DAV_PREFIX + '/')) {
      if (!hasBasic && !hasSession) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Farshelf", charset="UTF-8"', 'content-length': 0 });
        res.end();
        return;
      }
      return handleDav(app, req, res, url);
    }

    if (url.pathname.startsWith('/stream/')) {
      await handleStream(app, req, res, url, hasSession || hasBasic);
      return;
    }

    if (url.pathname === '/login' && req.method === 'GET') return loginPage(res);
    if (url.pathname === '/oauth/callback' && req.method === 'GET') return oauthCallback(url, res);

    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (req.method !== 'GET' && origin && !allowedOrigin(origin)) {
        sendJson(res, 403, { error: 'bad_origin', message: 'cross-origin request refused' });
        return;
      }
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const { token } = await readJson(req, z.object({ token: z.string() }));
        if (!app.checkToken(token)) {
          sendJson(res, 401, { error: 'bad_token', message: 'That login link is not valid. Run `farshelf url` to get a fresh one.' });
          return;
        }
        res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!hasSession) {
        sendJson(res, 401, { error: 'unauthenticated', message: 'Open the login link printed by `farshelf start` (or run `farshelf url`).' });
        return;
      }
      if (url.pathname === '/api/events') return events(req, res);
      if (await handleApi(app, req, res, url)) return;
      sendJson(res, 404, { error: 'not_found', message: 'unknown API route' });
      return;
    }

    return serveStatic(url, res);
  }

  function allowedOrigin(origin: string): boolean {
    if ((opts.extraOrigins ?? []).includes(origin)) return true;
    try {
      return allowedHosts().has(new URL(origin).host);
    } catch {
      return false;
    }
  }

  function loginPage(res: Res): void {
    const nonce = randomBytes(16).toString('base64');
    const html = `<!doctype html><meta charset="utf-8"><title>Farshelf sign-in</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem;color:#1d2a26;background:#f4f1ea}</style>
<p id="m">Signing in…</p>
<script nonce="${nonce}">
const t = new URLSearchParams(location.hash.slice(1)).get('t');
history.replaceState(null, '', '/login');
fetch('/api/session', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({token: t || ''})})
  .then(r => r.ok ? location.replace('/') : r.json().then(j => { document.getElementById('m').textContent = j.message; }));
</script>`;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`,
      'cache-control': 'no-store',
    });
    res.end(html);
  }

  async function oauthCallback(url: URL, res: Res): Promise<void> {
    const flow = await app.completeGoogleSignIn(url.searchParams.get('state') ?? '', url.searchParams.get('code'), url.searchParams.get('error'));
    const ok = !!flow.result;
    const msg = ok ? 'Signed in to Google. You can close this tab and return to Farshelf.' : `Google sign-in failed: ${flow.error}`;
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Farshelf</title><body style="font:16px system-ui;margin:4rem auto;max-width:32rem">${msg.replace(/[<>&]/g, '')}</body>`);
  }

  function events(req: Req, res: Res): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const send = (type: string) => (data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    const handlers: [string, (d: unknown) => void][] = [
      ['job', send('job')],
      ['activity', send('activity')],
      ['changed', send('changed')],
      ['trash', send('trash')],
      ['oauth', send('oauth')],
      ['state', () => void app.aiApiKey().then((k) => send('state')(appState(app, !!k)))],
    ];
    for (const [ev, fn] of handlers) app.on(ev, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      for (const [ev, fn] of handlers) app.off(ev, fn);
    });
  }

  async function serveStatic(url: URL, res: Res): Promise<void> {
    if (!webRoot) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Farshelf daemon is running, but the web UI is not built. Run `npm run build:web`.');
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(webRoot, '.' + rel);
    if (!file.startsWith(webRoot + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file)) file = path.join(webRoot, 'index.html'); // SPA fallback
    const data = await fs.readFile(file);
    const isHtml = file.endsWith('.html');
    res.writeHead(200, {
      'content-type': mimeType(file).replace('text/plain; charset=utf-8', 'text/html; charset=utf-8'),
      'cache-control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
      ...(isHtml
        ? {
            'content-security-policy':
              "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          }
        : {}),
    });
    res.end(data);
  }

  return server;
}
