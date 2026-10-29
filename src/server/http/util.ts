import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError, z } from 'zod';
import { AppError, errorMessage } from '../errors.ts';
import { DecryptError } from '../crypto/format.ts';

export type Req = IncomingMessage;
export type Res = ServerResponse;

export function sendJson(res: Res, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

export async function readBody(req: Req, limit = 1024 * 1024): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AppError(413, 'too_large', 'request body is too large');
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

export async function readJson<T>(req: Req, schema: z.ZodType<T>): Promise<T> {
  const raw = await readBody(req);
  let data: unknown = {};
  if (raw.length) {
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError(400, 'bad_json', 'request body is not valid JSON');
    }
  }
  return schema.parse(data);
}

export function handleError(res: Res, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof ZodError) {
    sendJson(res, 400, { error: 'invalid_input', message: z.prettifyError(err) });
  } else if (err instanceof AppError) {
    sendJson(res, err.status, { error: err.code, message: err.message });
  } else if (err instanceof DecryptError) {
    sendJson(res, 422, { error: 'decrypt_failed', message: `Decryption failed: ${err.message}` });
  } else {
    console.error('[farshelf] unexpected error:', err);
    sendJson(res, 500, { error: 'internal', message: `Unexpected error: ${errorMessage(err)}` });
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function basicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  js: 'text/javascript',
  css: 'text/css',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
};

export function mimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** Parse a single-range `Range` header. Returns null for "whole file", 'invalid' for unsatisfiable. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null; // multi-range or unknown unit: serve the whole file
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'invalid';
    return { start: Math.max(0, size - n), end: size };
  }
  const start = Number(a);
  const end = b === '' ? size : Math.min(size, Number(b) + 1);
  if (start >= size || end <= start) return 'invalid';
  return { start, end };
}

/** Write an async stream of chunks to the response, honouring back-pressure and client disconnects. */
export async function pipeChunks(chunks: AsyncGenerator<Uint8Array>, res: Res): Promise<void> {
  let closed = false;
  res.on('close', () => (closed = true));
  try {
    for await (const chunk of chunks) {
      if (closed) break;
      if (!res.write(chunk))
        await new Promise<void>((r) => {
          res.once('drain', r);
          res.once('close', r);
        });
    }
  } finally {
    await chunks.return(undefined);
  }
  if (!closed) res.end();
}

export function contentDisposition(name: string, attachment: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
