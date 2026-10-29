import http from 'node:http';
import https from 'node:https';
import { XMLParser } from 'fast-xml-parser';
import { AppError, ConflictError, NotFoundError, TransientError } from '../errors.ts';
import { normPath } from '../paths.ts';
import type { Backend, RemoteStat, UploadState } from './types.ts';

interface WebdavOptions {
  url: string;
  username?: string;
  password?: string;
}

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Any RFC 4918 server: Nextcloud, ownCloud, Apache mod_dav, nginx, rclone serve webdav, ... */
export class WebdavBackend implements Backend {
  readonly kind = 'webdav';
  readonly resumable = false;
  readonly chunkSize = 0;
  private readonly base: URL;
  private readonly auth: string | undefined;

  constructor(opts: WebdavOptions) {
    this.base = new URL(opts.url.endsWith('/') ? opts.url : opts.url + '/');
    this.auth =
      opts.username !== undefined
        ? 'Basic ' + Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64')
        : undefined;
  }

  describe(): string {
    return this.base.origin + this.base.pathname;
  }

  private url(p: string, dir = false): URL {
    const segs = normPath(p).split('/').filter(Boolean).map(encodeURIComponent);
    return new URL(segs.join('/') + (dir && segs.length ? '/' : ''), this.base);
  }

  private async req(
    method: string,
    url: URL,
    init: { headers?: Record<string, string>; body?: string } = {},
    signal?: AbortSignal,
  ) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...(this.auth ? { authorization: this.auth } : {}), ...init.headers },
        body: init.body,
        redirect: 'follow',
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new TransientError(`cannot reach WebDAV server ${this.base.host}`, { cause: err });
    }
    if (res.status >= 500 || res.status === 429) {
      throw new TransientError(`WebDAV server returned ${res.status} for ${method}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, 'remote_auth', `WebDAV server rejected the credentials (${res.status})`);
    }
    return res;
  }

  private async propfind(p: string, depth: '0' | '1'): Promise<{ href: string; stat: RemoteStat }[] | null> {
    const body =
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';
    const res = await this.req('PROPFIND', this.url(p), {
      headers: { depth, 'content-type': 'application/xml' },
      body,
    });
    if (res.status === 404) return null;
    if (res.status !== 207)
      throw new AppError(502, 'remote_error', `PROPFIND ${p} failed with ${res.status}`);
    const doc = parser.parse(await res.text());
    const out: { href: string; stat: RemoteStat }[] = [];
    for (const r of asArray(doc?.multistatus?.response)) {
      const href = decodeURIComponent(new URL(String(r.href), this.base).pathname);
      const ok = asArray(r.propstat).find((ps: { status?: string }) =>
        String(ps.status ?? '').includes(' 200'),
      );
      const prop = ok?.prop ?? {};
      const isDir =
        prop.resourcetype !== undefined &&
        typeof prop.resourcetype === 'object' &&
        'collection' in prop.resourcetype;
      const name = href.replace(/\/$/, '').split('/').pop() ?? '';
      out.push({
        href,
        stat: {
          name,
          kind: isDir ? 'dir' : 'file',
          size: isDir ? 0 : Number(prop.getcontentlength ?? 0),
          mtime: prop.getlastmodified ? Date.parse(String(prop.getlastmodified)) || 0 : 0,
        },
      });
    }
    return out;
  }

  async list(p: string): Promise<RemoteStat[]> {
    const items = await this.propfind(p, '1');
    if (!items) throw new NotFoundError(p);
    const self = decodeURIComponent(this.url(p, true).pathname).replace(/\/$/, '');
    return items.filter((i) => i.href.replace(/\/$/, '') !== self).map((i) => i.stat);
  }

  async stat(p: string): Promise<RemoteStat | null> {
    const items = await this.propfind(p, '0');
    return items?.[0]?.stat ?? null;
  }

  async read(p: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (end <= start) return new Uint8Array();
    const res = await this.req(
      'GET',
      this.url(p),
      { headers: { range: `bytes=${start}-${end - 1}` } },
      signal,
    );
    if (res.status === 404) throw new NotFoundError(p);
    if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
    if (res.status === 200) {
      // Server ignored Range: slice locally (correct, but downloads more than needed).
      const all = new Uint8Array(await res.arrayBuffer());
      return all.subarray(start, end);
    }
    throw new AppError(502, 'remote_error', `GET ${p} failed with ${res.status}`);
  }

  async mkdir(p: string): Promise<void> {
    const parts = normPath(p).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const sub = '/' + parts.slice(0, i).join('/');
      const res = await this.req('MKCOL', this.url(sub, true));
      if (res.status === 201 || res.status === 405 /* exists */) continue;
      throw new AppError(502, 'remote_error', `MKCOL ${sub} failed with ${res.status}`);
    }
  }

  async move(from: string, to: string): Promise<void> {
    const src = await this.stat(from);
    if (!src) throw new NotFoundError(from);
    const dest = this.url(to, src.kind === 'dir');
    const res = await this.req('MOVE', this.url(from, src.kind === 'dir'), {
      headers: { destination: dest.href, overwrite: 'F' },
    });
    if (res.status === 412) throw new ConflictError(`${to} already exists`);
    if (res.status === 409) {
      // Parent missing: create it and retry once.
      await this.mkdir(normPath(to).split('/').slice(0, -1).join('/') || '/');
      const again = await this.req('MOVE', this.url(from, src.kind === 'dir'), {
        headers: { destination: dest.href, overwrite: 'F' },
      });
      if (again.status >= 300) throw new AppError(502, 'remote_error', `MOVE failed with ${again.status}`);
      return;
    }
    if (res.status >= 300) throw new AppError(502, 'remote_error', `MOVE failed with ${res.status}`);
  }

  async remove(p: string): Promise<void> {
    if (normPath(p) === '/') throw new Error('refusing to remove the backend root');
    const res = await this.req('DELETE', this.url(p));
    if (res.status >= 300 && res.status !== 404)
      throw new AppError(502, 'remote_error', `DELETE failed with ${res.status}`);
  }

  async beginUpload(p: string, size: number): Promise<UploadState> {
    return { path: normPath(p), size };
  }

  async uploadedOffset(state: UploadState): Promise<number> {
    // WebDAV has no standard partial upload, so an interrupted upload restarts from zero.
    const st = await this.stat(String(state.path));
    return st && st.kind === 'file' && st.size === state.size && state.finished ? Number(state.size) : 0;
  }

  async uploadChunk(): Promise<void> {
    throw new Error('WebDAV uploads use putStream');
  }

  async abortUpload(): Promise<void> {}

  async putStream(
    p: string,
    size: number,
    body: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    const parent = normPath(p).split('/').slice(0, -1).join('/') || '/';
    if (parent !== '/') await this.mkdir(parent);
    const url = this.url(p);
    const mod = url.protocol === 'https:' ? https : http;
    await new Promise<void>((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method: 'PUT',
          headers: {
            'content-length': String(size),
            'content-type': 'application/octet-stream',
            ...(this.auth ? { authorization: this.auth } : {}),
          },
          signal,
        },
        (res) => {
          res.resume();
          const s = res.statusCode ?? 0;
          if (s >= 200 && s < 300) resolve();
          else if (s >= 500 || s === 429) reject(new TransientError(`WebDAV PUT returned ${s}`));
          else reject(new AppError(502, 'remote_error', `WebDAV PUT failed with ${s}`));
        },
      );
      req.on('error', (err) =>
        reject(signal?.aborted ? err : new TransientError('WebDAV upload interrupted', { cause: err })),
      );
      (async () => {
        for await (const chunk of body) {
          if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
        }
        req.end();
      })().catch((err) => req.destroy(err));
    });
  }
}
