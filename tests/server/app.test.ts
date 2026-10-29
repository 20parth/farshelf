import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/server/app.ts';
import { SEGMENT_SIZE } from '../../src/server/crypto/format.ts';
import { decryptTree } from '../../src/server/decrypt.ts';
import { MemorySecrets } from '../../src/server/secrets.ts';
import { makeApp, randomData, tmpDir, waitFor, waitJobsIdle } from './helpers.ts';

const open: App[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close().catch(() => undefined);
});

async function setup(opts: { passphrase?: string } = {}) {
  const { app, dir } = await makeApp();
  open.push(app);
  app.start();
  const root = await tmpDir('farshelf-store-');
  const { remote, recoveryKey } = await app.createRemote({
    kind: 'local',
    name: 'Store',
    config: { root },
    passphrase: opts.passphrase,
  });
  await waitJobsIdle(app);
  return { app, dir, root, id: remote.id, recoveryKey };
}

async function upload(app: App, id: string, p: string, data: Buffer, autoRename = false) {
  const job = await app.receiveUpload(id, p, Readable.from([data]), {
    expectedSize: data.length,
    autoRename,
  });
  await waitFor(() => app.jobs.get(job.id)?.state === 'done');
  return job;
}

describe('plain local remote', () => {
  it('uploads, lists, streams ranges, and indexes for search', async () => {
    const { app, id, root } = await setup();
    const data = randomData(SEGMENT_SIZE * 2 + 77);
    await upload(app, id, '/Films/trip reel.mov', data);
    expect((await fs.readFile(path.join(root, 'Films', 'trip reel.mov'))).equals(data)).toBe(true);
    const entries = await app.list(id, '/Films');
    expect(entries).toMatchObject([{ name: 'trip reel.mov', kind: 'file', size: data.length }]);
    const chunks: Uint8Array[] = [];
    for await (const c of app
      .vault(id)
      .readRange('/Films/trip reel.mov', SEGMENT_SIZE - 10, SEGMENT_SIZE + 10))
      chunks.push(c);
    expect(Buffer.concat(chunks).equals(data.subarray(SEGMENT_SIZE - 10, SEGMENT_SIZE + 10))).toBe(true);
    const results = app.search({ text: 'trip', sort: 'relevance', order: 'desc', limit: 10 });
    expect(results.map((r) => r.path)).toEqual(['/Films/trip reel.mov']);
    expect(
      app.search({ category: 'video', minSize: 1, sort: 'size', order: 'desc', limit: 10 }),
    ).toHaveLength(1);
    expect(app.search({ category: 'audio', sort: 'size', order: 'desc', limit: 10 })).toHaveLength(0);
  });

  it('shows queued uploads immediately and serves them from the spool', async () => {
    const { app, id } = await setup();
    await app.jobs.stop(); // keep the job queued
    const job = await app.receiveUpload(id, '/a.txt', Readable.from([Buffer.from('hello')]), {});
    const listing = await app.list(id, '/');
    expect(listing).toMatchObject([{ name: 'a.txt', pending: true, size: 5 }]);
    expect((await app.vault(id).readAll('/a.txt')).toString()).toBe('hello');
    expect(app.jobs.get(job.id)?.state).toBe('queued');
  });

  it('auto-renames on conflict when asked, and overwrites otherwise', async () => {
    const { app, id } = await setup();
    await upload(app, id, '/x.txt', Buffer.from('one'));
    await upload(app, id, '/x.txt', Buffer.from('two'), true);
    expect((await app.list(id, '/')).map((e) => e.name).sort()).toEqual(['x (1).txt', 'x.txt']);
    await upload(app, id, '/x.txt', Buffer.from('three'));
    expect((await app.vault(id).readAll('/x.txt')).toString()).toBe('three');
  });

  it('moves, trashes, restores and purges', async () => {
    const { app, id, root } = await setup();
    await upload(app, id, '/doc.pdf', Buffer.from('%PDF'));
    await app.mkdir(id, '/Archive');
    await app.move(id, '/doc.pdf', '/Archive/doc.pdf');
    expect(await app.vault(id).stat('/doc.pdf')).toBeNull();
    const item = await app.trash(id, '/Archive/doc.pdf');
    expect(await app.vault(id).stat('/Archive/doc.pdf')).toBeNull();
    expect(app.listTrash()).toHaveLength(1);
    expect((await app.list(id, '/')).map((e) => e.name)).toEqual(['Archive']); // trash dir hidden
    expect(app.search({ text: 'doc', sort: 'relevance', order: 'desc', limit: 5 })).toHaveLength(0);
    expect(await app.restore(item.id)).toBe('/Archive/doc.pdf');
    expect(
      app.search({ text: 'doc', sort: 'relevance', order: 'desc', limit: 5 }).map((r) => r.path),
    ).toEqual(['/Archive/doc.pdf']);
    expect((await app.vault(id).readAll('/Archive/doc.pdf')).toString()).toBe('%PDF');
    const again = await app.trash(id, '/Archive/doc.pdf');
    await app.purge(again.id);
    expect(app.listTrash()).toHaveLength(0);
    expect(await fs.readdir(path.join(root, '.farshelf-trash'))).toEqual([]);
  });

  it('purges trash older than the retention period', async () => {
    const { app, id } = await setup();
    await upload(app, id, '/old.txt', Buffer.from('x'));
    await app.trash(id, '/old.txt');
    expect(await app.purgeExpiredTrash(Date.now() + 29 * 86_400_000)).toBe(0);
    expect(await app.purgeExpiredTrash(Date.now() + 31 * 86_400_000)).toBe(1);
  });

  it('refuses reserved paths, moving into itself, and duplicate names', async () => {
    const { app, id } = await setup();
    await app.mkdir(id, '/A');
    await expect(app.mkdir(id, '/A')).rejects.toThrow(/already exists/);
    await expect(app.move(id, '/A', '/A/B')).rejects.toThrow(/into itself/);
    await expect(app.mkdir(id, '/.farshelf/x')).rejects.toThrow(/reserved/);
    await expect(app.trash(id, '/')).rejects.toThrow(/root/);
    await expect(
      app.createRemote({ kind: 'local', name: 'store', config: { root: '/tmp/x' } }),
    ).rejects.toThrow(/already exists/);
  });

  it('cancelling an upload deletes the spool file', async () => {
    const { app, id, dir } = await setup();
    await app.jobs.stop();
    const job = await app.receiveUpload(id, '/big.bin', Readable.from([randomData(1000)]), {});
    expect(await fs.readdir(path.join(dir, 'spool'))).toHaveLength(1);
    await app.jobs.cancel(job.id);
    expect(await fs.readdir(path.join(dir, 'spool'))).toHaveLength(0);
    expect(await app.list(id, '/')).toEqual([]);
  });

  it('records searchable activity', async () => {
    const { app, id } = await setup();
    await app.mkdir(id, '/Invoices 2026');
    expect(app.activity.list('invoices').map((a) => a.action)).toContain('mkdir');
    expect(app.activity.list('nonexistentword')).toHaveLength(0);
  });
});

describe('encrypted local remote', () => {
  it('stores only ciphertext and encrypted names, and reads back plaintext ranges', async () => {
    const { app, id, root, recoveryKey } = await setup({ passphrase: 'a long passphrase' });
    expect(recoveryKey).toBeTruthy();
    const data = randomData(SEGMENT_SIZE + 500);
    await upload(app, id, '/Secret Folder/passport scan.pdf', data);
    const top = (await fs.readdir(root)).filter((n) => !n.startsWith('.farshelf'));
    expect(top).toHaveLength(1);
    expect(top[0]).not.toContain('Secret');
    const inner = await fs.readdir(path.join(root, top[0]!));
    const stored = await fs.readFile(path.join(root, top[0]!, inner[0]!));
    expect(stored.length).toBeGreaterThan(data.length);
    expect(stored.includes(data.subarray(0, 64))).toBe(false);
    expect(await app.list(id, '/Secret Folder')).toMatchObject([
      { name: 'passport scan.pdf', size: data.length },
    ]);
    const chunks: Uint8Array[] = [];
    for await (const c of app
      .vault(id)
      .readRange('/Secret Folder/passport scan.pdf', SEGMENT_SIZE - 3, SEGMENT_SIZE + 3))
      chunks.push(c);
    expect(Buffer.concat(chunks).equals(data.subarray(SEGMENT_SIZE - 3, SEGMENT_SIZE + 3))).toBe(true);
  });

  it('locks, refuses access while locked, and unlocks with passphrase or recovery key', async () => {
    const { app, id, recoveryKey } = await setup({ passphrase: 'a long passphrase' });
    await upload(app, id, '/note.txt', Buffer.from('hi'));
    await app.lock(id);
    await expect(app.list(id, '/')).rejects.toThrow(/locked/);
    await expect(app.unlock(id, { passphrase: 'nope nope nope' })).rejects.toThrow(/wrong passphrase/);
    await app.unlock(id, { recoveryKey: recoveryKey! });
    expect((await app.vault(id).readAll('/note.txt')).toString()).toBe('hi');
  });

  it('can be re-attached on another machine with the passphrase, and decrypted offline', async () => {
    const { app, id, root } = await setup({ passphrase: 'a long passphrase' });
    await upload(app, id, '/a/b.txt', Buffer.from('portable'));
    const other = await makeApp();
    open.push(other.app);
    await expect(other.app.createRemote({ kind: 'local', name: 'Copy', config: { root } })).rejects.toThrow(
      /passphrase/,
    );
    const { remote, recoveryKey } = await other.app.createRemote({
      kind: 'local',
      name: 'Copy',
      config: { root },
      passphrase: 'a long passphrase',
    });
    expect(recoveryKey).toBeNull(); // existing vault reused
    expect((await other.app.vault(remote.id).readAll('/a/b.txt')).toString()).toBe('portable');
    const out = await tmpDir('farshelf-out-');
    expect(await decryptTree(root, out, { passphrase: 'a long passphrase' })).toBe(1);
    expect(await fs.readFile(path.join(out, 'a', 'b.txt'), 'utf8')).toBe('portable');
    void id;
  });

  it('changing the passphrase keeps files readable', async () => {
    const { app, id } = await setup({ passphrase: 'first passphrase' });
    await upload(app, id, '/f.txt', Buffer.from('ok'));
    await app.changePassphrase(id, 'second passphrase');
    await app.lock(id);
    await expect(app.unlock(id, { passphrase: 'first passphrase' })).rejects.toThrow();
    await app.unlock(id, { passphrase: 'second passphrase' });
    expect((await app.vault(id).readAll('/f.txt')).toString()).toBe('ok');
  });
});

describe('restart recovery', () => {
  it('resumes an interrupted upload from the confirmed offset after a restart (encrypted)', async () => {
    const dir = await tmpDir();
    const secrets = new MemorySecrets();
    const root = await tmpDir('farshelf-store-');
    const first = await makeApp({ dataDir: dir, secrets });
    const { remote } = await first.app.createRemote({
      kind: 'local',
      name: 'S',
      config: { root },
      passphrase: 'a long passphrase',
    });
    const data = randomData(20 * 1024 * 1024 + 3);
    const job = await first.app.receiveUpload(remote.id, '/big.bin', Readable.from([data]), {});
    // Simulate a crash after the first chunk: run one chunk by hand and mark the job as running.
    const vault = first.app.vault(remote.id);
    const payload = first.app.jobs.payload(job.id) as { spoolPath: string; size: number; header: string };
    const stored = vault.storedSize(data.length);
    const state = await vault.backend.beginUpload(vault.remotePath('/big.bin'), stored);
    const read = vault.uploadReader(payload.spoolPath, data.length, Buffer.from(payload.header, 'base64'));
    await vault.backend.uploadChunk(state, 0, await read(0, vault.backend.chunkSize));
    first.app.db
      .prepare(`update jobs set state = 'running', payload = ? where id = ?`)
      .run(JSON.stringify({ ...payload, state }), job.id);
    first.app.db.close(); // "crash" without a clean shutdown

    const second = await makeApp({ dataDir: dir, secrets });
    open.push(second.app);
    expect(second.app.jobs.get(job.id)?.state).toBe('queued');
    expect(second.app.listRemotes()[0]!.locked).toBe(true); // memory secrets: master key not persisted
    second.app.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(second.app.jobs.get(job.id)?.state).toBe('queued'); // waits while locked
    await second.app.unlock(remote.id, { passphrase: 'a long passphrase' });
    await waitFor(() => second.app.jobs.get(job.id)?.state === 'done');
    expect((await second.app.vault(remote.id).readAll('/big.bin')).equals(data)).toBe(true);
    expect(second.app.activity.list('resumed').length).toBe(1);
  });
});
