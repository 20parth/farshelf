// Per-remote access layer: path/name encryption, block reads with cache and read-ahead, pending-upload overlay.
import fs from 'node:fs/promises';
import type { Entry } from '../shared/schemas.ts';
import type { Backend, RemoteStat } from './backends/types.ts';
import type { BlockCache } from './cache.ts';
import {
  ciphertextRange,
  decryptSegment,
  encryptedSize,
  HEADER_SIZE,
  openHeader,
  plainSize,
  SEGMENT_SIZE,
  segmentCount,
  segmentLocation,
  type FileCrypto,
} from './crypto/format.ts';
import { NameCipher, vaultDocSchema, type VaultDoc } from './crypto/keys.ts';
import { DecryptError } from './crypto/format.ts';
import { AppError, LockedError, NotFoundError } from './errors.ts';
import { baseName, joinPath, normPath, parentOf } from './paths.ts';

export const BLOCK_SIZE = SEGMENT_SIZE;
export const META_DIR = '/.farshelf';
export const TRASH_DIR = '/.farshelf-trash';
const VAULT_FILE = '/.farshelf/vault.json';
const HIDDEN_AT_ROOT = new Set(['.farshelf', '.farshelf-trash']);

export interface PendingFile {
  spoolPath: string;
  size: number;
  mtime: number;
}

export interface FileStat extends RemoteStat {
  /** size of the object stored on the backend (ciphertext size for encrypted remotes) */
  storedSize: number;
}

export interface VaultOptions {
  remoteId: string;
  remoteName: string;
  backend: Backend;
  encrypted: boolean;
  cache: BlockCache;
  readAhead: () => number;
  pending: () => Map<string, PendingFile>;
}

export class Vault {
  readonly remoteId: string;
  readonly remoteName: string;
  readonly backend: Backend;
  readonly encrypted: boolean;
  private masterKey: Buffer | null = null;
  private names: NameCipher | null = null;
  private readonly cache: BlockCache;
  private readonly readAhead: () => number;
  private readonly pending: () => Map<string, PendingFile>;
  private readonly statCache = new Map<string, { at: number; st: FileStat | null }>();
  private readonly headers = new Map<string, FileCrypto>();
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private readonly lastBlock = new Map<string, number>();

  constructor(o: VaultOptions) {
    this.remoteId = o.remoteId;
    this.remoteName = o.remoteName;
    this.backend = o.backend;
    this.encrypted = o.encrypted;
    this.cache = o.cache;
    this.readAhead = o.readAhead;
    this.pending = o.pending;
  }

  // ---------- keys ----------

  get locked(): boolean {
    return this.encrypted && !this.masterKey;
  }

  setMasterKey(key: Buffer | null): void {
    this.masterKey = key;
    this.names = key ? new NameCipher(key) : null;
    this.headers.clear();
    this.statCache.clear();
    if (!key) this.cache.invalidate(`${this.remoteId}:`);
  }

  getMasterKey(): Buffer {
    if (!this.masterKey) throw new LockedError(this.remoteName);
    return this.masterKey;
  }

  async readVaultDoc(): Promise<VaultDoc | null> {
    const st = await this.backend.stat(VAULT_FILE);
    if (!st) return null;
    const raw = await this.backend.read(VAULT_FILE, 0, st.size);
    return vaultDocSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')));
  }

  async writeVaultDoc(doc: VaultDoc): Promise<void> {
    await this.backend.mkdir(META_DIR);
    await writeSmall(this.backend, VAULT_FILE, Buffer.from(JSON.stringify(doc, null, 2)));
  }

  // ---------- paths ----------

  /** Map a plaintext path to the path stored on the backend. */
  remotePath(p: string): string {
    const n = normPath(p);
    if (!this.encrypted || n === '/') return n;
    const names = this.names ?? (() => { throw new LockedError(this.remoteName); })();
    return '/' + n.split('/').filter(Boolean).map((s) => names.encrypt(s)).join('/');
  }

  /** Path inside the trash area: /.farshelf-trash/<id>/<name>, with the name encrypted when needed. */
  trashPath(id: string, name: string): string {
    return `${TRASH_DIR}/${id}/${this.encrypted ? this.names!.encrypt(name) : name}`;
  }

  private decodeStat(st: RemoteStat): RemoteStat | null {
    if (!this.encrypted) return st;
    try {
      const name = this.names!.decrypt(st.name);
      if (st.kind === 'dir') return { ...st, name };
      return { ...st, name, size: plainSize(st.size) };
    } catch (err) {
      if (err instanceof DecryptError) return null; // not ours (or a partial upload); hide it
      throw err;
    }
  }

  // ---------- metadata ----------

  async list(p: string): Promise<Entry[]> {
    if (this.locked) throw new LockedError(this.remoteName);
    const dir = normPath(p);
    const raw = await this.backend.list(this.remotePath(dir));
    const out = new Map<string, Entry>();
    for (const r of raw) {
      if (dir === '/' && HIDDEN_AT_ROOT.has(r.name)) continue;
      const st = this.decodeStat(r);
      if (!st) continue;
      out.set(st.name, { name: st.name, path: joinPath(dir, st.name), kind: st.kind, size: st.size, mtime: st.mtime });
    }
    for (const [path, pf] of this.pending()) {
      if (parentOf(path) !== dir) continue;
      const name = baseName(path);
      out.set(name, { name, path, kind: 'file', size: pf.size, mtime: pf.mtime, pending: true });
    }
    return [...out.values()];
  }

  async stat(p: string): Promise<FileStat | null> {
    if (this.locked) throw new LockedError(this.remoteName);
    const n = normPath(p);
    const pf = this.pending().get(n);
    if (pf) return { name: baseName(n), kind: 'file', size: pf.size, mtime: pf.mtime, storedSize: pf.size };
    const hit = this.statCache.get(n);
    if (hit && Date.now() - hit.at < 5000) return hit.st;
    const raw = await this.backend.stat(this.remotePath(n));
    let st: FileStat | null = null;
    if (raw) {
      if (n === '/') st = { ...raw, name: '', storedSize: 0 };
      else {
        const d = this.decodeStat(raw);
        st = d ? { ...d, storedSize: raw.size } : null;
      }
    }
    this.statCache.set(n, { at: Date.now(), st });
    return st;
  }

  /** Forget cached metadata and blocks for a path (and everything under it). */
  invalidate(p: string): void {
    const n = normPath(p);
    for (const k of [...this.statCache.keys()]) if (k === n || k.startsWith(n + '/') || n === '/') this.statCache.delete(k);
    for (const k of [...this.headers.keys()]) if (k === n || k.startsWith(n + '/')) this.headers.delete(k);
    this.cache.invalidate(`${this.remoteId}:${n}`);
  }

  // ---------- reads ----------

  private blockKey(p: string, st: FileStat, index: number): string {
    return `${this.remoteId}:${p}\0${st.storedSize}:${st.mtime}:${index}`;
  }

  private async header(p: string): Promise<FileCrypto> {
    const cached = this.headers.get(p);
    if (cached) return cached;
    const raw = await this.backend.read(this.remotePath(p), 0, HEADER_SIZE);
    const fc = openHeader(this.getMasterKey(), raw);
    this.headers.set(p, fc);
    return fc;
  }

  private async fetchBlock(p: string, st: FileStat, index: number): Promise<Uint8Array> {
    const pf = this.pending().get(p);
    const start = index * BLOCK_SIZE;
    const end = Math.min(st.size, start + BLOCK_SIZE);
    if (pf) return readFileRange(pf.spoolPath, start, end);
    if (!this.encrypted) return this.backend.read(this.remotePath(p), start, end);
    const fc = await this.header(p);
    const loc = segmentLocation(index, st.size);
    const sealed = await this.backend.read(this.remotePath(p), loc.offset, loc.offset + loc.length);
    if (sealed.length !== loc.length) throw new DecryptError('file is truncated');
    return decryptSegment(fc, index, index === segmentCount(st.size) - 1, sealed);
  }

  private block(p: string, st: FileStat, index: number): Promise<Uint8Array> {
    const key = this.blockKey(p, st, index);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const pr = this.fetchBlock(p, st, index)
      .then((b) => {
        this.cache.set(key, b);
        return b;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pr);
    return pr;
  }

  private prefetch(p: string, st: FileStat, index: number): void {
    const fileKey = `${p}\0${st.storedSize}`;
    const prev = this.lastBlock.get(fileKey);
    this.lastBlock.set(fileKey, index);
    if (this.lastBlock.size > 1000) this.lastBlock.delete(this.lastBlock.keys().next().value!);
    if (prev === undefined || index !== prev + 1) return; // only on sequential access
    const last = Math.ceil(st.size / BLOCK_SIZE) - 1;
    for (let i = index + 1; i <= Math.min(last, index + this.readAhead()); i++) {
      this.block(p, st, i).catch(() => undefined);
    }
  }

  /** Stream plaintext bytes [start, end) block by block. */
  async *readRange(p: string, start: number, end: number): AsyncGenerator<Uint8Array> {
    const n = normPath(p);
    const st = await this.stat(n);
    if (!st || st.kind !== 'file') throw new NotFoundError(n);
    end = Math.min(end, st.size);
    let pos = start;
    while (pos < end) {
      const index = Math.floor(pos / BLOCK_SIZE);
      this.prefetch(n, st, index);
      const b = await this.block(n, st, index);
      const from = pos - index * BLOCK_SIZE;
      const to = Math.min(b.length, end - index * BLOCK_SIZE);
      if (to <= from) throw new AppError(502, 'short_read', 'the remote returned less data than expected');
      yield b.subarray(from, to);
      pos = index * BLOCK_SIZE + to;
    }
  }

  async readAll(p: string): Promise<Buffer> {
    const parts: Uint8Array[] = [];
    for await (const c of this.readRange(p, 0, Number.MAX_SAFE_INTEGER)) parts.push(c);
    return Buffer.concat(parts);
  }

  // ---------- writes ----------

  async mkdir(p: string): Promise<void> {
    await this.backend.mkdir(this.remotePath(p));
    this.invalidate(parentOf(p));
    this.invalidate(p);
  }

  async move(from: string, to: string): Promise<void> {
    await this.backend.move(this.remotePath(from), this.remotePath(to));
    this.invalidate(from);
    this.invalidate(to);
  }

  /** Size the backend object will have for a plaintext file of `size` bytes. */
  storedSize(size: number): number {
    return this.encrypted ? encryptedSize(size) : size;
  }

  /** Return a function producing stored bytes [start,end) of the upload, encrypting deterministically if needed. */
  uploadReader(spoolPath: string, size: number, header: Buffer | null): (start: number, end: number) => Promise<Uint8Array> {
    if (!this.encrypted) return (start, end) => readFileRange(spoolPath, start, Math.min(end, size));
    const fc = openHeader(this.getMasterKey(), header!);
    return (start, end) => ciphertextRange(fc, size, start, end, (o, l) => readFileRange(spoolPath, o, o + l));
  }
}

export async function readFileRange(file: string, start: number, end: number): Promise<Buffer> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buf.subarray(0, filled);
  } finally {
    await fh.close();
  }
}

/** Upload a small in-memory object using whichever upload style the backend supports. */
export async function writeSmall(backend: Backend, path: string, data: Buffer): Promise<void> {
  if (backend.putStream) {
    await backend.putStream(path, data.length, (async function* () { yield data; })());
    return;
  }
  const state = await backend.beginUpload(path, data.length);
  await backend.uploadChunk(state, 0, data);
}
