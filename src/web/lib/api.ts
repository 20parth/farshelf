import type {
  ActivityItem,
  AiPlan,
  AppState,
  Entry,
  JobInfo,
  RemoteInfo,
  SearchFilter,
  SearchResult,
  Settings,
  TrashItem,
} from '../../shared/schemas.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: raw
        ? { 'content-type': 'application/octet-stream' }
        : body !== undefined
          ? { 'content-type': 'application/json' }
          : {},
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach the Farshelf daemon. Is it still running?');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok)
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? `Request failed (${res.status})`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  createRemote: (input: unknown) =>
    request<{ remote: RemoteInfo; recoveryKey: string | null }>('POST', '/api/remotes', input),
  removeRemote: (id: string) => request('DELETE', `/api/remotes/${enc(id)}`),
  unlock: (id: string, secret: { passphrase: string } | { recoveryKey: string }) =>
    request('POST', `/api/remotes/${enc(id)}/unlock`, secret),
  lock: (id: string) => request('POST', `/api/remotes/${enc(id)}/lock`),
  changePassphrase: (id: string, passphrase: string) =>
    request('POST', `/api/remotes/${enc(id)}/passphrase`, { passphrase }),
  index: (id: string) => request<JobInfo>('POST', `/api/remotes/${enc(id)}/index`),
  list: (id: string, path: string) =>
    request<{ entries: Entry[] }>('GET', `/api/remotes/${enc(id)}/list?path=${enc(path)}`),
  link: (id: string, path: string) =>
    request<{ url: string }>('GET', `/api/remotes/${enc(id)}/link?path=${enc(path)}`),
  mkdir: (id: string, path: string, source: 'user' | 'ai' = 'user') =>
    request('POST', `/api/remotes/${enc(id)}/mkdir`, { path, source }),
  move: (id: string, from: string, to: string, source: 'user' | 'ai' = 'user') =>
    request('POST', `/api/remotes/${enc(id)}/move`, { from, to, source }),
  trash: (id: string, path: string, source: 'user' | 'ai' = 'user') =>
    request<TrashItem>('POST', `/api/remotes/${enc(id)}/trash`, { path, source }),
  upload: (id: string, path: string, file: Blob, mtime?: number) =>
    request<JobInfo>(
      'PUT',
      `/api/remotes/${enc(id)}/upload?path=${enc(path)}${mtime ? `&mtime=${mtime}` : ''}`,
      undefined,
      file,
    ),
  trashList: () => request<{ items: TrashItem[] }>('GET', '/api/trash'),
  restore: (id: string) => request<{ path: string }>('POST', `/api/trash/${enc(id)}/restore`),
  purge: (id: string) => request('DELETE', `/api/trash/${enc(id)}`),
  jobs: () => request<{ jobs: JobInfo[] }>('GET', '/api/jobs'),
  jobAction: (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') =>
    request<JobInfo>('POST', `/api/jobs/${enc(id)}/${action}`),
  clearJobs: () => request('POST', '/api/jobs/clear'),
  search: (filter: Partial<SearchFilter>) =>
    request<{ results: SearchResult[] }>('POST', '/api/search', filter),
  activity: (q: string) => request<{ items: ActivityItem[] }>('GET', `/api/activity?q=${enc(q)}`),
  updateSettings: (patch: Record<string, unknown>) => request<Settings>('PATCH', '/api/settings', patch),
  clearCache: () => request('POST', '/api/cache/clear'),
  mount: () => request('POST', '/api/mount'),
  shutdown: () => request('POST', '/api/shutdown'),
  googleStart: (clientId: string, clientSecret: string) =>
    request<{ flowId: string; authUrl: string }>('POST', '/api/oauth/google/start', {
      clientId: clientId || undefined,
      clientSecret: clientSecret || undefined,
    }),
  googleStatus: (flowId: string) =>
    request<{ done: boolean; ok: boolean; email: string | null; error: string | null }>(
      'GET',
      `/api/oauth/google/${enc(flowId)}`,
    ),
  aiTest: () =>
    request<{ ok: boolean; models: string[]; modelAvailable: boolean; location: 'local' | 'remote' }>(
      'POST',
      '/api/ai/test',
    ),
  aiSearch: (question: string) =>
    request<{ filter: SearchFilter; results: SearchResult[] }>('POST', '/api/ai/search', { question }),
  aiPlan: (input: { request: string; remoteId: string; cwd: string; shareNames: boolean }) =>
    request<{ plan: AiPlan; sharedNames: boolean; encryptedWithheld: boolean }>(
      'POST',
      '/api/ai/plan',
      input,
    ),
};
