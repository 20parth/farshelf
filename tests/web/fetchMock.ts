import { vi } from 'vitest';
import type { AppState } from '../../src/shared/schemas.ts';

export type Route = (body: unknown, url: URL) => unknown;

export function baseState(over: Partial<AppState> = {}): AppState {
  return {
    version: '0.1.0',
    remotes: [
      {
        id: 'r1',
        name: 'Studio',
        kind: 'local',
        encrypted: false,
        locked: false,
        createdAt: 0,
        summary: '/tmp/studio',
      },
    ],
    settings: {
      cacheLimitMiB: 256,
      readAheadBlocks: 6,
      uploadConcurrency: 2,
      trashRetentionDays: 30,
      lastUploadRemoteId: null,
      ai: {
        enabled: false,
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'llama3.2',
        timeoutMs: 60000,
      },
    },
    aiKeyStored: false,
    dav: { url: 'http://127.0.0.1:7420/dav/', username: 'farshelf', password: 'pw' },
    cache: { bytes: 0, limit: 1, entries: 0 },
    platform: 'linux',
    keychain: 'memory',
    ...over,
  };
}

/** Install a fetch mock; routes are keyed "METHOD /path". Returns the list of calls made. */
export function mockFetch(routes: Record<string, Route | { status: number; body: unknown }>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, path: url.pathname, body });
    const route = routes[`${method} ${url.pathname}`];
    if (!route)
      return new Response(
        JSON.stringify({ error: 'not_found', message: `no mock for ${method} ${url.pathname}` }),
        { status: 404 },
      );
    if (typeof route === 'function')
      return new Response(JSON.stringify(route(body, url) ?? { ok: true }), { status: 200 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  });
  return calls;
}
