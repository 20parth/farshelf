// Google Drive backend against an in-memory mock of the Drive v3 + OAuth endpoints.
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  finishOAuth,
  GdriveBackend,
  startOAuth,
  type GoogleEndpoints,
} from '../../src/server/backends/gdrive.ts';
import { randomData } from './helpers.ts';

interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  data: Buffer;
  modifiedTime: string;
  trashed: boolean;
}

const FOLDER = 'application/vnd.google-apps.folder';
const files = new Map<string, MockFile>();
const sessions = new Map<
  string,
  { fileId: string | null; meta: { name?: string; parents?: string[] }; size: number; received: Buffer }
>();
const codes = new Map<string, string>(); // code -> challenge
let server: http.Server;
let ep: GoogleEndpoints;
let failNextChunk = false;
let tokenRefreshes = 0;

function evalQuery(q: string, f: MockFile): boolean {
  const unq = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  return q.split(' and ').every((clause) => {
    let m;
    if ((m = clause.match(/^'((?:[^'\\]|\\.)*)' in parents$/))) return f.parents.includes(unq(m[1]!));
    if ((m = clause.match(/^name = '((?:[^'\\]|\\.)*)'$/))) return f.name === unq(m[1]!);
    if ((m = clause.match(/^mimeType = '(.*)'$/))) return f.mimeType === m[1];
    if (clause === 'trashed = false') return !f.trashed;
    throw new Error('unsupported clause ' + clause);
  });
}

const view = (f: MockFile) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  size: f.mimeType === FOLDER ? undefined : String(f.data.length),
  modifiedTime: f.modifiedTime,
});

async function body(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    const raw = await body(req);
    if (url.pathname === '/token') {
      const p = new URLSearchParams(raw.toString());
      if (p.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(p.get('code')!);
        const ok = challenge === createHash('sha256').update(p.get('code_verifier')!).digest('base64url');
        if (!ok) return send(400, { error: 'invalid_grant' });
        const idToken = `x.${Buffer.from(JSON.stringify({ email: 'me@example.com' })).toString('base64url')}.y`;
        return send(200, { access_token: 'at', refresh_token: 'rt-1', id_token: idToken, expires_in: 3600 });
      }
      tokenRefreshes++;
      return p.get('refresh_token') === 'rt-1'
        ? send(200, { access_token: 'at', expires_in: 3600 })
        : send(400, { error: 'invalid_grant' });
    }
    if (req.headers.authorization !== 'Bearer at') return send(401, { error: 'unauthorized' });
    let m;
    if (url.pathname === '/drive/files' && req.method === 'GET') {
      const q = url.searchParams.get('q')!.replace("'root' in parents", "'root' in parents");
      return send(200, { files: [...files.values()].filter((f) => evalQuery(q, f)).map(view) });
    }
    if (url.pathname === '/drive/files' && req.method === 'POST') {
      const meta = JSON.parse(raw.toString());
      const f: MockFile = {
        id: randomUUID(),
        name: meta.name,
        mimeType: meta.mimeType,
        parents: meta.parents ?? ['root'],
        data: Buffer.alloc(0),
        modifiedTime: new Date().toISOString(),
        trashed: false,
      };
      files.set(f.id, f);
      return send(200, view(f));
    }
    if ((m = url.pathname.match(/^\/drive\/files\/([^/]+)$/))) {
      const f = files.get(decodeURIComponent(m[1]!));
      if (!f) return send(404, { error: 'notFound' });
      if (req.method === 'GET' && url.searchParams.get('alt') === 'media') {
        const r = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
        if (!r) return void res.writeHead(200).end(f.data);
        res.writeHead(206, { 'content-range': `bytes ${r[1]}-${r[2]}/${f.data.length}` });
        return void res.end(f.data.subarray(Number(r[1]), Number(r[2]) + 1));
      }
      if (req.method === 'PATCH') {
        const meta = JSON.parse(raw.toString() || '{}');
        if (meta.name) f.name = meta.name;
        const add = url.searchParams.get('addParents');
        const remove = url.searchParams.get('removeParents');
        if (add) f.parents = [...f.parents.filter((p) => p !== remove), add];
        return send(200, view(f));
      }
      if (req.method === 'DELETE') {
        const del = (id: string) => {
          files.delete(id);
          for (const c of [...files.values()].filter((x) => x.parents.includes(id))) del(c.id);
        };
        del(f.id);
        return send(204);
      }
    }
    if (url.pathname.startsWith('/upload/files') && url.searchParams.get('uploadType') === 'resumable') {
      const sid = randomUUID();
      const fileId = url.pathname.split('/')[3] ?? null;
      sessions.set(sid, {
        fileId,
        meta: JSON.parse(raw.toString() || '{}'),
        size: Number(req.headers['x-upload-content-length']),
        received: Buffer.alloc(0),
      });
      return send(200, {}, { location: `${ep.uploadBase}/session/${sid}` });
    }
    if ((m = url.pathname.match(/^\/upload\/session\/(.+)$/))) {
      const s = sessions.get(m[1]!);
      if (!s) return send(404);
      const cr = String(req.headers['content-range'] ?? '');
      const finish = () => {
        const f: MockFile = s.fileId
          ? files.get(s.fileId)!
          : {
              id: randomUUID(),
              name: s.meta.name!,
              mimeType: 'application/octet-stream',
              parents: s.meta.parents!,
              data: Buffer.alloc(0),
              modifiedTime: '',
              trashed: false,
            };
        f.data = s.received;
        f.modifiedTime = new Date().toISOString();
        files.set(f.id, f);
        return send(200, view(f));
      };
      if (cr.startsWith('bytes */')) {
        if (s.received.length === s.size && s.size > 0) return send(200, {});
        if (s.size === 0) return finish();
        return send(308, undefined, s.received.length ? { range: `bytes=0-${s.received.length - 1}` } : {});
      }
      const r = cr.match(/bytes (\d+)-(\d+)\/(\d+)/)!;
      if (failNextChunk) {
        failNextChunk = false;
        return send(503, { error: 'backendError' });
      }
      if (Number(r[1]) !== s.received.length) return send(400, { error: 'bad offset' });
      s.received = Buffer.concat([s.received, raw]);
      if (s.received.length === s.size) return finish();
      return send(308, undefined, { range: `bytes=0-${s.received.length - 1}` });
    }
    send(404, { error: 'no route ' + url.pathname });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ep = {
    authUrl: `${base}/auth`,
    tokenUrl: `${base}/token`,
    apiBase: `${base}/drive`,
    uploadBase: `${base}/upload`,
  };
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Google OAuth (PKCE)', () => {
  it('builds a drive.file-only consent URL and exchanges the code with the verifier', async () => {
    const { flow, authUrl } = startOAuth(
      'client-id-123',
      undefined,
      'http://127.0.0.1:7420/oauth/callback',
      ep,
    );
    const u = new URL(authUrl);
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    codes.set('code-1', u.searchParams.get('code_challenge')!);
    const result = await finishOAuth(flow, 'code-1', ep);
    expect(result).toEqual({ refreshToken: 'rt-1', email: 'me@example.com' });
    const tampered = { ...flow, verifier: 'wrong' };
    await expect(finishOAuth(tampered, 'code-1', ep)).rejects.toThrow(/sign-in failed/);
  });
});

describe('Google Drive backend', () => {
  const drive = () => new GdriveBackend({ clientId: 'c', refreshToken: 'rt-1' }, 'Farshelf', ep);

  it('creates its own root folder and does folder/file operations', async () => {
    const d = drive();
    expect(await d.list('/')).toEqual([]);
    expect([...files.values()].filter((f) => f.name === 'Farshelf')).toHaveLength(1);
    await d.mkdir('/Films/2026');
    await drive().mkdir('/Films/2026'); // idempotent across instances
    expect((await d.list('/Films')).map((s) => s.name)).toEqual(['2026']);
    expect([...files.values()].filter((f) => f.name === 'Farshelf')).toHaveLength(1);
  });

  it('uploads in resumable chunks, survives a 503 mid-way, and reads ranges', async () => {
    const d = drive();
    const data = randomData(d.chunkSize * 2 + 1234);
    const state = await d.beginUpload("/Films/it's here.mov", data.length);
    await d.uploadChunk(state, 0, data.subarray(0, d.chunkSize));
    failNextChunk = true;
    await expect(
      d.uploadChunk(state, d.chunkSize, data.subarray(d.chunkSize, 2 * d.chunkSize)),
    ).rejects.toThrow(/503/);
    // A new process would ask the session how far it got.
    const offset = await drive().uploadedOffset(state);
    expect(offset).toBe(d.chunkSize);
    await d.uploadChunk(state, offset, data.subarray(offset, 2 * d.chunkSize));
    await d.uploadChunk(state, 2 * d.chunkSize, data.subarray(2 * d.chunkSize));
    expect(await d.uploadedOffset(state)).toBe(data.length);
    const st = await d.stat("/Films/it's here.mov");
    expect(st).toMatchObject({ kind: 'file', size: data.length });
    expect(Buffer.from(await d.read("/Films/it's here.mov", 100, 200)).equals(data.subarray(100, 200))).toBe(
      true,
    );
  });

  it('replaces an existing file in place, moves, renames and deletes', async () => {
    const d = drive();
    for (const content of ['v1', 'version two']) {
      const s = await d.beginUpload('/notes.txt', content.length);
      await d.uploadChunk(s, 0, Buffer.from(content));
    }
    expect((await d.list('/')).filter((x) => x.name === 'notes.txt')).toHaveLength(1);
    expect(Buffer.from(await d.read('/notes.txt', 0, 11)).toString()).toBe('version two');
    await d.move('/notes.txt', '/Films/notes renamed.txt');
    expect(await d.stat('/notes.txt')).toBeNull();
    expect((await d.stat('/Films/notes renamed.txt'))?.size).toBe(11);
    await expect(d.move('/Films/notes renamed.txt', '/Films/2026')).rejects.toThrow(/already exists/);
    await d.remove('/Films');
    expect(await d.stat('/Films/notes renamed.txt')).toBeNull();
  });

  it('handles empty files', async () => {
    const d = drive();
    const s = await d.beginUpload('/empty.txt', 0);
    await d.uploadChunk(s, 0, new Uint8Array());
    expect((await d.stat('/empty.txt'))?.size).toBe(0);
  });

  it('reports a revoked sign-in clearly', async () => {
    const d = new GdriveBackend({ clientId: 'c', refreshToken: 'revoked' }, 'Farshelf', ep);
    await expect(d.list('/')).rejects.toThrow(/refused the stored sign-in/);
    expect(tokenRefreshes).toBeGreaterThan(0);
  });
});
