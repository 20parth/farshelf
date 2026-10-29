import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { App, type AppOptions } from '../../src/server/app.ts';
import { createServer } from '../../src/server/http/server.ts';
import { MemorySecrets } from '../../src/server/secrets.ts';

export const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

export async function tmpDir(prefix = 'farshelf-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function makeApp(over: Partial<AppOptions> = {}): Promise<{ app: App; dir: string }> {
  const dir = over.dataDir ?? (await tmpDir());
  const app = await App.open({
    dataDir: dir,
    baseUrl: 'http://127.0.0.1:0',
    secrets: new MemorySecrets(),
    kdfParams: FAST_KDF,
    backoffMs: () => 50,
    ...over,
  });
  return { app, dir };
}

export async function serve(app: App): Promise<{ server: http.Server; base: string; close: () => Promise<void> }> {
  const server = createServer(app, { webRoot: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  app.baseUrl = base;
  return {
    server,
    base,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function randomData(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 65536) {
    const chunk = Buffer.from(crypto.getRandomValues(new Uint8Array(Math.min(65536, n - i))));
    chunk.copy(b, i);
  }
  return b;
}

export async function waitJobsIdle(app: App): Promise<void> {
  await waitFor(() => app.jobs.list().every((j) => !['queued', 'running'].includes(j.state)));
}
