// Range-capable file serving for players and browsers (/stream) and for WebDAV GET.
import type { App } from '../app.ts';
import { NotFoundError } from '../errors.ts';
import { baseName } from '../paths.ts';
import type { Vault } from '../vault.ts';
import { contentDisposition, mimeType, parseRange, pipeChunks, type Req, type Res } from './util.ts';

export async function serveFile(
  vault: Vault,
  p: string,
  req: Req,
  res: Res,
  opts: { download?: boolean } = {},
): Promise<void> {
  const st = await vault.stat(p);
  if (!st || st.kind !== 'file') throw new NotFoundError(p);
  const etag = `"${st.storedSize.toString(36)}-${Math.round(st.mtime).toString(36)}"`;
  const headers: Record<string, string | number> = {
    'accept-ranges': 'bytes',
    'content-type': mimeType(st.name),
    etag,
    'last-modified': new Date(st.mtime || Date.now()).toUTCString(),
    'content-disposition': contentDisposition(baseName(p), !!opts.download),
    'cache-control': 'private, no-cache',
    // Never let a stored HTML/SVG file run script in Farshelf's origin.
    'content-security-policy':
      "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, st.size);
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${st.size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? st.size;
  headers['content-length'] = end - start;
  if (range) headers['content-range'] = `bytes ${start}-${end - 1}/${st.size}`;
  if (req.method === 'HEAD') {
    res.writeHead(range ? 206 : 200, headers);
    res.end();
    return;
  }
  // Fetch the first block before committing headers so errors still produce a proper status code.
  const chunks = vault.readRange(p, start, end);
  const first = await chunks.next();
  res.writeHead(range ? 206 : 200, headers);
  async function* all() {
    if (!first.done) yield first.value;
    yield* chunks;
  }
  await pipeChunks(all(), res);
}

/** GET /stream/<remoteId>/<path>?sig=... — signed links work without a session, so they can be pasted into VLC/IINA. */
export async function handleStream(
  app: App,
  req: Req,
  res: Res,
  url: URL,
  authed: boolean,
): Promise<boolean> {
  const m = url.pathname.match(/^\/stream\/([^/]+)(\/.*)$/);
  if (!m) return false;
  const remoteId = decodeURIComponent(m[1]!);
  const p = m[2]!.split('/').map(decodeURIComponent).join('/');
  const sig = url.searchParams.get('sig');
  if (!authed && !app.checkStreamSignature(remoteId, p, sig)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('This stream link is not valid. Copy a fresh link from Farshelf.');
    return true;
  }
  await serveFile(app.vault(remoteId), p, req, res, { download: url.searchParams.get('download') === '1' });
  return true;
}
