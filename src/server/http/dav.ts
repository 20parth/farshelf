// WebDAV (RFC 4918 class 1 + stub locks) so desktop file managers can mount Farshelf at /dav.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { App } from '../app.ts';
import { AppError, ConflictError, NotFoundError } from '../errors.ts';
import { baseName, normPath, parentOf } from '../paths.ts';
import type { Vault } from '../vault.ts';
import { serveFile } from './stream.ts';
import { handleError, mimeType, readBody, type Req, type Res } from './util.ts';

export const DAV_PREFIX = '/dav';

// macOS/Windows metadata files: kept in memory only, never uploaded to the user's storage.
const JUNK = /^(\.DS_Store|\._.*|\.localized|\.TemporaryItems|\.Trashes|\.Spotlight-V100|\.fseventsd|\.metadata_never_index.*|\.ql_.*|desktop\.ini|Thumbs\.db)$/;
const junkStore = new Map<string, { data: Buffer; mtime: number }>();
const JUNK_LIMIT = 256 * 1024;

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
const hrefFor = (segments: string[], dir: boolean) =>
  DAV_PREFIX + '/' + segments.map(encodeURIComponent).join('/') + (dir && segments.length ? '/' : '');

interface Located {
  vault: Vault | null; // null = the virtual root listing remotes
  path: string; // path inside the remote
  segments: string[];
}

function locate(app: App, pathname: string): Located {
  const rest = pathname.slice(DAV_PREFIX.length);
  const segments = rest.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (!segments.length) return { vault: null, path: '/', segments };
  const vault = app.vaultByName(segments[0]!);
  if (!vault) throw new NotFoundError(segments[0]!);
  return { vault, path: normPath('/' + segments.slice(1).join('/')), segments };
}

function propXml(href: string, p: { name: string; dir: boolean; size: number; mtime: number }): string {
  const date = new Date(p.mtime || Date.now());
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>
<D:displayname>${xmlEscape(p.name)}</D:displayname>
<D:resourcetype>${p.dir ? '<D:collection/>' : ''}</D:resourcetype>
${p.dir ? '' : `<D:getcontentlength>${p.size}</D:getcontentlength><D:getcontenttype>${xmlEscape(mimeType(p.name))}</D:getcontenttype><D:getetag>"${p.size.toString(36)}-${Math.round(p.mtime).toString(36)}"</D:getetag>`}
<D:getlastmodified>${date.toUTCString()}</D:getlastmodified>
<D:creationdate>${date.toISOString()}</D:creationdate>
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(res: Res, body: string): void {
  const data = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`);
  res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

function empty(res: Res, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-length': 0, ...headers });
  res.end();
}

function requireVault(loc: Located): Vault {
  if (!loc.vault || loc.path === '/') throw new AppError(403, 'forbidden', 'cannot modify the top level of the Farshelf drive');
  return loc.vault;
}

function davError(res: Res, err: unknown): void {
  if (err instanceof NotFoundError) return empty(res, 404);
  if (err instanceof AppError && err.code === 'locked') return empty(res, 423);
  if (err instanceof AppError) {
    const body = Buffer.from(err.message);
    res.writeHead(err.status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
    res.end(body);
    return;
  }
  handleError(res, err);
}

export async function handleDav(app: App, req: Req, res: Res, url: URL): Promise<void> {
  try {
    await route(app, req, res, url);
  } catch (err) {
    davError(res, err);
  }
}

async function route(app: App, req: Req, res: Res, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') {
    return empty(res, 200, {
      dav: '1, 2',
      'ms-author-via': 'DAV',
      allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK',
    });
  }
  const loc = locate(app, url.pathname);
  const name = loc.segments.at(-1) ?? '';
  const junkKey = `${loc.vault?.remoteId}:${loc.path}`;

  if (JUNK.test(name) && !['LOCK', 'UNLOCK', 'PROPPATCH'].includes(method)) return handleJunk(req, res, method, junkKey, loc);

  switch (method) {
    case 'PROPFIND': {
      const depth = req.headers.depth === '0' ? 0 : 1;
      await readBody(req); // body is ignored: we always return the full property set
      if (!loc.vault) {
        let body = propXml(DAV_PREFIX + '/', { name: 'Farshelf', dir: true, size: 0, mtime: Date.now() });
        if (depth) {
          for (const r of app.listRemotes()) body += propXml(hrefFor([r.name], true), { name: r.name, dir: true, size: 0, mtime: r.createdAt });
        }
        return multistatus(res, body);
      }
      const st = await loc.vault.stat(loc.path);
      if (!st) return empty(res, 404);
      const isDir = st.kind === 'dir';
      let body = propXml(hrefFor(loc.segments, isDir), { name: loc.path === '/' ? loc.vault.remoteName : st.name, dir: isDir, size: st.size, mtime: st.mtime });
      if (isDir && depth) {
        const entries = await app.list(loc.vault.remoteId, loc.path);
        for (const e of entries) {
          body += propXml(hrefFor([...loc.segments, e.name], e.kind === 'dir'), { name: e.name, dir: e.kind === 'dir', size: e.size, mtime: e.mtime });
        }
      }
      return multistatus(res, body);
    }
    case 'GET':
    case 'HEAD': {
      if (!loc.vault) return empty(res, 405);
      const st = await loc.vault.stat(loc.path);
      if (!st) return empty(res, 404);
      if (st.kind === 'dir') {
        const msg = Buffer.from('This is a folder. Mount this address in your file manager to browse it.');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': msg.length });
        return void res.end(method === 'HEAD' ? undefined : msg);
      }
      return serveFile(loc.vault, loc.path, req, res);
    }
    case 'PUT': {
      const vault = requireVault(loc);
      const parent = await vault.stat(parentOf(loc.path));
      if (!parent || parent.kind !== 'dir') return empty(res, 409);
      const existed = !!(await vault.stat(loc.path));
      const declared = req.headers['x-expected-entity-length'] ?? req.headers['content-length'];
      await app.receiveUpload(vault.remoteId, loc.path, req, { expectedSize: declared !== undefined ? Number(declared) : undefined });
      return empty(res, existed ? 204 : 201);
    }
    case 'MKCOL': {
      const vault = requireVault(loc);
      if ((await readBody(req)).length) return empty(res, 415);
      if (await vault.stat(loc.path)) return empty(res, 405);
      const parent = await vault.stat(parentOf(loc.path));
      if (!parent) return empty(res, 409);
      await app.mkdir(vault.remoteId, loc.path);
      return empty(res, 201);
    }
    case 'DELETE': {
      const vault = requireVault(loc);
      await app.trash(vault.remoteId, loc.path);
      return empty(res, 204);
    }
    case 'MOVE':
    case 'COPY': {
      const vault = requireVault(loc);
      const destHeader = req.headers.destination;
      if (!destHeader) return empty(res, 400);
      const dest = locate(app, new URL(String(destHeader), url).pathname);
      if (dest.vault?.remoteId !== vault.remoteId || dest.path === '/') return empty(res, 502); // cross-remote not supported
      const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase() !== 'F';
      const destExists = !!(await vault.stat(dest.path));
      if (destExists && !overwrite) return empty(res, 412);
      if (!(await vault.stat(parentOf(dest.path)))) return empty(res, 409);
      if (destExists) await app.trash(vault.remoteId, dest.path);
      if (method === 'MOVE') {
        await app.move(vault.remoteId, loc.path, dest.path);
      } else {
        const st = await vault.stat(loc.path);
        if (!st) return empty(res, 404);
        if (st.kind === 'dir') throw new ConflictError('copying folders over WebDAV is not supported yet; copy the files instead');
        await app.receiveUpload(vault.remoteId, dest.path, Readable.from(vault.readRange(loc.path, 0, st.size)), { expectedSize: st.size });
      }
      return empty(res, destExists ? 204 : 201);
    }
    case 'LOCK': {
      await readBody(req);
      const token = `opaquelocktoken:${randomUUID()}`;
      const body = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>
<D:depth>0</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken>
<D:lockroot><D:href>${xmlEscape(url.pathname)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'lock-token': `<${token}>` });
      return void res.end(body);
    }
    case 'UNLOCK':
      return empty(res, 204);
    case 'PROPPATCH': {
      await readBody(req);
      // Accept and ignore (Finder sets Apple-specific properties); report success so copies don't fail.
      return multistatus(res, `<D:response><D:href>${xmlEscape(url.pathname)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
    default:
      return empty(res, 405);
  }
}

async function handleJunk(req: Req, res: Res, method: string, key: string, loc: Located): Promise<void> {
  switch (method) {
    case 'PUT': {
      const data = await readBody(req, JUNK_LIMIT);
      junkStore.set(key, { data, mtime: Date.now() });
      if (junkStore.size > 2000) junkStore.delete(junkStore.keys().next().value!);
      return empty(res, 201);
    }
    case 'GET':
    case 'HEAD': {
      const item = junkStore.get(key);
      if (!item) return empty(res, 404);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': item.data.length });
      return void res.end(method === 'HEAD' ? undefined : item.data);
    }
    case 'PROPFIND': {
      await readBody(req);
      const item = junkStore.get(key);
      if (!item) return empty(res, 404);
      return multistatus(res, propXml(hrefFor(loc.segments, false), { name: baseName(loc.path), dir: false, size: item.data.length, mtime: item.mtime }));
    }
    case 'DELETE':
      junkStore.delete(key);
      return empty(res, 204);
    default:
      return empty(res, 403);
  }
}
