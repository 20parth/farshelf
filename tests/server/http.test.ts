import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/server/app.ts';
import { WebdavBackend } from '../../src/server/backends/webdav.ts';
import { makeApp, randomData, serve, tmpDir, waitFor, waitJobsIdle } from './helpers.ts';

let app: App;
let base: string;
let root: string;
let id: string;
let close: () => Promise<void>;
let cookie: string;
let dav: string;

beforeEach(async () => {
  ({ app } = await makeApp());
  ({ base, close } = await serve(app));
  app.start();
  root = await tmpDir('farshelf-store-');
  ({
    remote: { id },
  } = await app.createRemote({ kind: 'local', name: 'My Store', config: { root } }));
  cookie = `farshelf_session=${app.auth.apiToken}`;
  dav = 'Basic ' + Buffer.from(`farshelf:${app.auth.davPassword}`).toString('base64');
  await waitJobsIdle(app);
});

afterEach(async () => {
  await close();
  await app.close();
});

const api = (p: string, init: RequestInit = {}) =>
  fetch(base + p, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers as object) },
  });

describe('API security', () => {
  it('requires a session', async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(401);
  });

  it('exchanges the login token for an HttpOnly SameSite cookie', async () => {
    const bad = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: 'nope' }),
    });
    expect(bad.status).toBe(401);
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: app.auth.apiToken }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
  });

  it('rejects cross-origin writes and unknown Host headers (DNS rebinding)', async () => {
    const res = await api('/api/remotes/' + id + '/mkdir', {
      method: 'POST',
      body: '{"path":"/x"}',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        `${base}/api/state`,
        { headers: { host: 'attacker.example:80', cookie } },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.end();
    });
    expect(status).toBe(421);
  });

  it('validates input with useful messages', async () => {
    const res = await api(`/api/remotes/${id}/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path: '../etc' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/must start with \//);
  });

  it('does not leak secrets in state other than the WebDAV password for the signed-in user', async () => {
    const state = await (await api('/api/state')).json();
    expect(JSON.stringify(state)).not.toContain(app.auth.apiToken);
    expect(state.dav.username).toBe('farshelf');
  });
});

describe('API file operations', () => {
  it('uploads, lists and streams with Range', async () => {
    const data = randomData(3 * 1024 * 1024);
    const up = await api(`/api/remotes/${id}/upload?path=${encodeURIComponent('/clip.mp4')}`, {
      method: 'PUT',
      body: data,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const job = await up.json();
    await waitFor(() => app.jobs.get(job.id)?.state === 'done');
    const list = await (await api(`/api/remotes/${id}/list?path=/`)).json();
    expect(list.entries[0]).toMatchObject({ name: 'clip.mp4', size: data.length });

    const r = await fetch(`${base}/stream/${id}/clip.mp4`, { headers: { cookie, range: 'bytes=100-199' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 100-199/${data.length}`);
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await r.arrayBuffer()).equals(data.subarray(100, 200))).toBe(true);

    const suffix = await fetch(`${base}/stream/${id}/clip.mp4`, { headers: { cookie, range: 'bytes=-10' } });
    expect(Buffer.from(await suffix.arrayBuffer()).equals(data.subarray(data.length - 10))).toBe(true);

    const bad = await fetch(`${base}/stream/${id}/clip.mp4`, {
      headers: { cookie, range: `bytes=${data.length}-` },
    });
    expect(bad.status).toBe(416);

    const full = await fetch(`${base}/stream/${id}/clip.mp4`, { headers: { cookie } });
    expect(Buffer.from(await full.arrayBuffer()).equals(data)).toBe(true);
  });

  it('serves signed stream links without a session, and rejects bad signatures', async () => {
    await fs.writeFile(path.join(root, 'song.mp3'), 'abc');
    const { url } = await (await api(`/api/remotes/${id}/link?path=/song.mp3`)).json();
    expect(url).toContain('sig=');
    const ok = await fetch(url);
    expect(await ok.text()).toBe('abc');
    expect(ok.headers.get('content-security-policy')).toContain('sandbox');
    const forged = await fetch(url.replace(/sig=.*/, 'sig=AAAA'));
    expect(forged.status).toBe(401);
    const other = await fetch(url.replace('song.mp3', 'other.mp3'));
    expect(other.status).toBe(401);
  });

  it('runs job actions and reports bad transitions', async () => {
    await app.jobs.stop();
    const up = await api(`/api/remotes/${id}/upload?path=/a.bin`, { method: 'PUT', body: 'abc' });
    const job = await up.json();
    expect((await (await api(`/api/jobs/${job.id}/pause`, { method: 'POST' })).json()).state).toBe('paused');
    expect((await (await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' })).json()).state).toBe(
      'cancelled',
    );
    const res = await api(`/api/jobs/${job.id}/resume`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('streams server-sent events for job changes', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    await api(`/api/remotes/${id}/mkdir`, { method: 'POST', body: JSON.stringify({ path: '/Events' }) });
    let text = '';
    while (!text.includes('event: changed')) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toContain('"path":"/"');
  });

  it('asks the process to stop when the user quits from the app', async () => {
    let asked = false;
    app.once('shutdown', () => (asked = true));
    const res = await api('/api/shutdown', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(asked).toBe(true);
    expect((await fetch(`${base}/api/shutdown`, { method: 'POST' })).status).toBe(401);
  });

  it('reports AI as disabled by default', async () => {
    const res = await api('/api/ai/search', {
      method: 'POST',
      body: JSON.stringify({ question: 'big videos' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('ai_disabled');
  });
});

describe('WebDAV server', () => {
  const req = (method: string, p: string, init: RequestInit = {}) =>
    fetch(base + p, { ...init, method, headers: { authorization: dav, ...(init.headers as object) } });

  it('requires credentials', async () => {
    const res = await fetch(`${base}/dav/`, { method: 'PROPFIND' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Basic/);
  });

  it('advertises DAV and lists remotes at the root', async () => {
    const opt = await req('OPTIONS', '/dav/');
    expect(opt.headers.get('dav')).toContain('1');
    const res = await req('PROPFIND', '/dav/', { headers: { depth: '1' } });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain('<D:href>/dav/My%20Store/</D:href>');
  });

  it('supports PUT, GET with Range, MKCOL, MOVE, COPY, DELETE (to trash) and LOCK', async () => {
    expect((await req('MKCOL', '/dav/My%20Store/Docs/')).status).toBe(201);
    expect((await req('MKCOL', '/dav/My%20Store/Docs/')).status).toBe(405);
    expect((await req('MKCOL', '/dav/My%20Store/missing/child/')).status).toBe(409);
    expect((await req('PUT', '/dav/My%20Store/Docs/a.txt', { body: 'hello world' })).status).toBe(201);
    await waitJobsIdle(app);
    const g = await req('GET', '/dav/My%20Store/Docs/a.txt', { headers: { range: 'bytes=6-10' } });
    expect(g.status).toBe(206);
    expect(await g.text()).toBe('world');
    const pf = await (await req('PROPFIND', '/dav/My%20Store/Docs/', { headers: { depth: '1' } })).text();
    expect(pf).toContain('<D:getcontentlength>11</D:getcontentlength>');
    expect(
      (
        await req('MOVE', '/dav/My%20Store/Docs/a.txt', {
          headers: { destination: `${base}/dav/My%20Store/Docs/b.txt` },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await req('COPY', '/dav/My%20Store/Docs/b.txt', {
          headers: { destination: `${base}/dav/My%20Store/c.txt` },
        })
      ).status,
    ).toBe(201);
    await waitJobsIdle(app);
    expect(await fs.readFile(path.join(root, 'c.txt'), 'utf8')).toBe('hello world');
    expect(
      (
        await req('MOVE', '/dav/My%20Store/c.txt', {
          headers: { destination: `${base}/dav/My%20Store/Docs/b.txt`, overwrite: 'F' },
        })
      ).status,
    ).toBe(412);
    const lock = await req('LOCK', '/dav/My%20Store/Docs/b.txt', { body: '<lockinfo/>' });
    expect(lock.headers.get('lock-token')).toMatch(/opaquelocktoken/);
    expect((await req('DELETE', '/dav/My%20Store/Docs/b.txt')).status).toBe(204);
    expect(app.listTrash().map((t) => t.originalPath)).toContain('/Docs/b.txt');
    expect((await req('DELETE', '/dav/My%20Store/')).status).toBe(403);
  });

  it('keeps Finder metadata files in memory instead of uploading them', async () => {
    expect((await req('PUT', '/dav/My%20Store/._photo.jpg', { body: 'meta' })).status).toBe(201);
    expect((await req('PUT', '/dav/My%20Store/.DS_Store', { body: 'meta' })).status).toBe(201);
    expect(await (await req('GET', '/dav/My%20Store/._photo.jpg')).text()).toBe('meta');
    await waitJobsIdle(app);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('works as a backend for another Farshelf (client/server interoperability)', async () => {
    const client = new WebdavBackend({
      url: `${base}/dav/My%20Store/`,
      username: 'farshelf',
      password: app.auth.davPassword,
    });
    await client.mkdir('/Interop/Deep');
    const body = randomData(100_000);
    await client.putStream(
      '/Interop/Deep/x.bin',
      body.length,
      (async function* () {
        yield body;
      })(),
    );
    await waitJobsIdle(app);
    expect((await client.list('/Interop/Deep')).map((s) => s.name)).toEqual(['x.bin']);
    expect((await client.stat('/Interop/Deep/x.bin'))?.size).toBe(body.length);
    expect(Buffer.from(await client.read('/Interop/Deep/x.bin', 10, 20)).equals(body.subarray(10, 20))).toBe(
      true,
    );
    await client.move('/Interop/Deep/x.bin', '/Interop/y.bin');
    expect(await client.stat('/Interop/Deep/x.bin')).toBeNull();
    await client.remove('/Interop/y.bin');
    expect(await client.stat('/Interop/y.bin')).toBeNull();
  });
});
