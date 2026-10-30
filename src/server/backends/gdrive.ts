// Google Drive API v3 backend, limited to the drive.file scope (only files Farshelf created).
import { createHash, randomBytes } from 'node:crypto';
import { AppError, ConflictError, NotFoundError, TransientError } from '../errors.ts';
import { normPath } from '../paths.ts';
import type { Backend, RemoteStat, UploadState } from './types.ts';

const FOLDER = 'application/vnd.google-apps.folder';

export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  apiBase: string;
  uploadBase: string;
}

export const GOOGLE: GoogleEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  apiBase: 'https://www.googleapis.com/drive/v3',
  uploadBase: 'https://www.googleapis.com/upload/drive/v3',
};

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GDRIVE_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE];

export interface GdriveCredentials {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

const FIELDS = 'id,name,mimeType,size,modifiedTime';

function toStat(f: DriveFile): RemoteStat {
  const dir = f.mimeType === FOLDER;
  return {
    name: f.name,
    kind: dir ? 'dir' : 'file',
    size: dir ? 0 : Number(f.size ?? 0),
    mtime: Date.parse(f.modifiedTime ?? '') || 0,
  };
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class GdriveBackend implements Backend {
  readonly kind = 'gdrive';
  readonly resumable = true;
  readonly chunkSize = 8 * 1024 * 1024; // must be a multiple of 256 KiB
  private accessToken: { value: string; expires: number } | null = null;
  private readonly ids = new Map<string, string>();
  private readonly creds: GdriveCredentials;
  private readonly folderName: string;
  private readonly ep: GoogleEndpoints;

  constructor(creds: GdriveCredentials, folderName: string, ep: GoogleEndpoints = GOOGLE) {
    this.creds = creds;
    this.folderName = folderName;
    this.ep = ep;
  }

  describe(): string {
    return `Google Drive › ${this.folderName}`;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60_000) return this.accessToken.value;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.creds.refreshToken,
      client_id: this.creds.clientId,
      ...(this.creds.clientSecret ? { client_secret: this.creds.clientSecret } : {}),
    });
    let res: Response;
    try {
      res = await fetch(this.ep.tokenUrl, { method: 'POST', body });
    } catch (err) {
      throw new TransientError('cannot reach Google sign-in', { cause: err });
    }
    if (res.status >= 500) throw new TransientError(`Google token endpoint returned ${res.status}`);
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new AppError(
        502,
        'remote_auth',
        `Google refused the stored sign-in (${json.error ?? res.status}). Remove and re-add this remote.`,
      );
    }
    this.accessToken = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  private async api(url: string, init: RequestInit = {}): Promise<Response> {
    const doFetch = async () =>
      fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${await this.token()}`,
        },
      });
    let res: Response;
    try {
      res = await doFetch();
      if (res.status === 401) {
        this.accessToken = null;
        res = await doFetch();
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      if (err instanceof AppError) throw err;
      throw new TransientError('cannot reach Google Drive', { cause: err });
    }
    if (res.status >= 500 || res.status === 429)
      throw new TransientError(`Google Drive returned ${res.status}`);
    if (res.status === 403) {
      const text = await res.clone().text();
      if (/rateLimit|userRateLimitExceeded/.test(text))
        throw new TransientError('Google Drive rate limit; will retry');
    }
    return res;
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 403 && /insufficient.*scope|insufficientPermissions/i.test(detail)) {
        throw new AppError(
          403,
          'drive_not_allowed',
          'Google did not give Farshelf access to Drive. Sign in with Google again and tick the Google Drive box on the permission screen.',
        );
      }
      if (res.status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(detail)) {
        throw new AppError(
          403,
          'drive_api_disabled',
          'The Google Drive API is not enabled for your Google Cloud project. Enable it under APIs & Services › Library › Google Drive API, wait a minute, and try again.',
        );
      }
      throw new AppError(
        502,
        'remote_error',
        `Google Drive ${what} failed (${res.status}) ${detail.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }

  private async findChild(parentId: string, name: string): Promise<DriveFile | null> {
    const params = new URLSearchParams({
      q: `${q(parentId)} in parents and name = ${q(name)} and trashed = false`,
      fields: `files(${FIELDS})`,
      pageSize: '10',
    });
    const out = await this.json<{ files: DriveFile[] }>(
      await this.api(`${this.ep.apiBase}/files?${params}`),
      'lookup',
    );
    return out.files[0] ?? null;
  }

  private async createFolder(parentId: string | null, name: string): Promise<DriveFile> {
    const res = await this.api(`${this.ep.apiBase}/files?fields=${FIELDS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}) }),
    });
    return this.json<DriveFile>(res, 'create folder');
  }

  private async rootId(): Promise<string> {
    const cached = this.ids.get('/');
    if (cached) return cached;
    const params = new URLSearchParams({
      q: `name = ${q(this.folderName)} and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`,
      fields: `files(${FIELDS})`,
    });
    const found = await this.json<{ files: DriveFile[] }>(
      await this.api(`${this.ep.apiBase}/files?${params}`),
      'find root',
    );
    const root = found.files[0] ?? (await this.createFolder('root', this.folderName));
    this.ids.set('/', root.id);
    return root.id;
  }

  private async resolve(p: string): Promise<DriveFile | null> {
    const n = normPath(p);
    if (n === '/') return { id: await this.rootId(), name: '', mimeType: FOLDER };
    const parts = n.split('/').filter(Boolean);
    let parentId = await this.rootId();
    let file: DriveFile | null = null;
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      file = await this.findChild(parentId, part);
      if (!file) {
        this.ids.delete(cur);
        return null;
      }
      this.ids.set(cur, file.id);
      parentId = file.id;
    }
    return file;
  }

  async list(p: string): Promise<RemoteStat[]> {
    const dir = await this.resolve(p);
    if (!dir || dir.mimeType !== FOLDER) throw new NotFoundError(p);
    const out: RemoteStat[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `${q(dir.id)} in parents and trashed = false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: '1000',
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(
        await this.api(`${this.ep.apiBase}/files?${params}`),
        'list',
      );
      out.push(...page.files.map(toStat));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async stat(p: string): Promise<RemoteStat | null> {
    const f = await this.resolve(p);
    return f ? toStat(f) : null;
  }

  async read(p: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (end <= start) return new Uint8Array();
    const f = await this.resolve(p);
    if (!f || f.mimeType === FOLDER) throw new NotFoundError(p);
    const res = await this.api(`${this.ep.apiBase}/files/${encodeURIComponent(f.id)}?alt=media`, {
      headers: { range: `bytes=${start}-${end - 1}` },
      signal,
    });
    if (res.status === 206) return new Uint8Array(await res.arrayBuffer());
    if (res.status === 200) return new Uint8Array(await res.arrayBuffer()).subarray(start, end);
    if (res.status === 416) return new Uint8Array();
    throw new AppError(502, 'remote_error', `Google Drive download failed (${res.status})`);
  }

  async mkdir(p: string): Promise<void> {
    const parts = normPath(p).split('/').filter(Boolean);
    let parentId = await this.rootId();
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      const existing = await this.findChild(parentId, part);
      if (existing && existing.mimeType !== FOLDER)
        throw new ConflictError(`a file already exists at ${cur}`);
      const folder = existing ?? (await this.createFolder(parentId, part));
      this.ids.set(cur, folder.id);
      parentId = folder.id;
    }
  }

  private parentAndName(p: string): { parent: string; name: string } {
    const n = normPath(p);
    return { parent: n.slice(0, n.lastIndexOf('/')) || '/', name: n.slice(n.lastIndexOf('/') + 1) };
  }

  async move(from: string, to: string): Promise<void> {
    const src = await this.resolve(from);
    if (!src) throw new NotFoundError(from);
    if (await this.resolve(to)) throw new ConflictError(`${to} already exists`);
    const a = this.parentAndName(from);
    const b = this.parentAndName(to);
    await this.mkdir(b.parent);
    const oldParent = (await this.resolve(a.parent))!.id;
    const newParent = (await this.resolve(b.parent))!.id;
    const params = new URLSearchParams({ fields: FIELDS });
    if (oldParent !== newParent) {
      params.set('addParents', newParent);
      params.set('removeParents', oldParent);
    }
    await this.json(
      await this.api(`${this.ep.apiBase}/files/${encodeURIComponent(src.id)}?${params}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: b.name }),
      }),
      'move',
    );
    this.forget(from);
  }

  private forget(prefix: string): void {
    const n = normPath(prefix);
    for (const k of [...this.ids.keys()]) if (k === n || k.startsWith(n + '/')) this.ids.delete(k);
  }

  async remove(p: string): Promise<void> {
    if (normPath(p) === '/') throw new Error('refusing to remove the backend root');
    const f = await this.resolve(p);
    if (!f) return;
    const res = await this.api(`${this.ep.apiBase}/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404)
      throw new AppError(502, 'remote_error', `Google Drive delete failed (${res.status})`);
    this.forget(p);
  }

  async beginUpload(p: string, size: number): Promise<UploadState> {
    const { parent, name } = this.parentAndName(p);
    await this.mkdir(parent);
    const parentId = (await this.resolve(parent))!.id;
    const existing = await this.findChild(parentId, name);
    if (existing?.mimeType === FOLDER) throw new ConflictError(`a folder already exists at ${p}`);
    const url = existing
      ? `${this.ep.uploadBase}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${FIELDS}`
      : `${this.ep.uploadBase}/files?uploadType=resumable&fields=${FIELDS}`;
    const res = await this.api(url, {
      method: existing ? 'PATCH' : 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify(existing ? {} : { name, parents: [parentId] }),
    });
    const session = res.headers.get('location');
    if (!res.ok || !session)
      throw new AppError(502, 'remote_error', `Google Drive refused to start the upload (${res.status})`);
    return { path: normPath(p), size, session };
  }

  async uploadedOffset(state: UploadState): Promise<number> {
    const size = Number(state.size);
    const res = await this.api(String(state.session), {
      method: 'PUT',
      headers: { 'content-range': `bytes */${size}`, 'content-length': '0' },
    });
    if (res.status === 200 || res.status === 201) return size;
    if (res.status === 308) {
      const range = res.headers.get('range');
      const m = range?.match(/bytes=0-(\d+)/);
      return m ? Number(m[1]) + 1 : 0;
    }
    if (res.status === 404 || res.status === 410)
      throw new AppError(410, 'upload_expired', 'the upload session expired; restart the upload');
    throw new AppError(502, 'remote_error', `Google Drive upload status failed (${res.status})`);
  }

  async uploadChunk(
    state: UploadState,
    offset: number,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const size = Number(state.size);
    const last = offset + data.length - 1;
    const res = await this.api(String(state.session), {
      method: 'PUT',
      headers: {
        'content-range': size === 0 ? 'bytes */0' : `bytes ${offset}-${last}/${size}`,
      },
      body: data,
      signal,
    });
    if (res.status === 308 || res.status === 200 || res.status === 201) {
      if (offset + data.length === size) this.ids.delete(String(state.path));
      return;
    }
    if (res.status === 404 || res.status === 410)
      throw new AppError(410, 'upload_expired', 'the upload session expired; restart the upload');
    throw new AppError(502, 'remote_error', `Google Drive upload failed (${res.status})`);
  }

  async abortUpload(state: UploadState): Promise<void> {
    if (state.session) await this.api(String(state.session), { method: 'DELETE' }).catch(() => undefined);
  }
}

// ---- OAuth (installed-app loopback flow with PKCE) ----

export interface OAuthFlow {
  id: string;
  state: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  createdAt: number;
  result?: { refreshToken: string; email: string | null };
  error?: string;
  /** Save this client for future sign-ins once it succeeds (set when the user typed it in). */
  remember?: boolean;
}

export function startOAuth(
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
  ep = GOOGLE,
) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const flow: OAuthFlow = {
    id: randomBytes(12).toString('base64url'),
    state: randomBytes(16).toString('base64url'),
    verifier,
    clientId,
    clientSecret,
    redirectUri,
    createdAt: Date.now(),
  };
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GDRIVE_SCOPES.join(' '),
    state: flow.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return { flow, authUrl: `${ep.authUrl}?${params}` };
}

export async function finishOAuth(
  flow: OAuthFlow,
  code: string,
  ep = GOOGLE,
): Promise<{ refreshToken: string; email: string | null }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: flow.verifier,
    client_id: flow.clientId,
    redirect_uri: flow.redirectUri,
    ...(flow.clientSecret ? { client_secret: flow.clientSecret } : {}),
  });
  const res = await fetch(ep.tokenUrl, { method: 'POST', body });
  const json = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  // Google's consent screen lets people sign in while leaving the Drive box unticked.
  if (res.ok && json.scope && !json.scope.split(' ').includes(DRIVE_FILE_SCOPE)) {
    throw new AppError(
      403,
      'drive_not_allowed',
      'You signed in, but Google Drive access was not allowed. Click “Sign in with Google” again and tick the box “See, edit, create and delete only the specific Google Drive files you use with this app”.',
    );
  }
  if (!res.ok || !json.refresh_token) {
    throw new AppError(
      502,
      'oauth_failed',
      `Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`,
    );
  }
  let email: string | null = null;
  if (json.id_token) {
    try {
      // Received directly from Google's token endpoint over TLS, so the payload is only decoded for display.
      email =
        JSON.parse(Buffer.from(json.id_token.split('.')[1] ?? '', 'base64url').toString()).email ?? null;
    } catch {
      email = null;
    }
  }
  return { refreshToken: json.refresh_token, email };
}
