import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../errors.ts';
import { normPath } from '../paths.ts';
import type { Backend, RemoteStat, UploadState } from './types.ts';

const PART_PREFIX = '.farshelf-part-';

/** Any directory on this machine: an external disk, NAS mount, or a folder another client syncs. */
export class LocalBackend implements Backend {
  readonly kind = 'local';
  readonly resumable = true;
  readonly chunkSize = 8 * 1024 * 1024;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  describe(): string {
    return this.root;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private abs(p: string): string {
    const rel = normPath(p).slice(1);
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep))
      throw new Error('path escapes backend root');
    return full;
  }

  async list(p: string): Promise<RemoteStat[]> {
    const dir = this.abs(p);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(p);
      throw err;
    }
    const out: RemoteStat[] = [];
    for (const name of names) {
      if (name.startsWith(PART_PREFIX)) continue;
      const st = await fs.lstat(path.join(dir, name)).catch(() => null);
      if (!st || st.isSymbolicLink()) continue; // never follow links out of the root
      out.push({
        name,
        kind: st.isDirectory() ? 'dir' : 'file',
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
      });
    }
    return out;
  }

  async stat(p: string): Promise<RemoteStat | null> {
    const st = await fs.lstat(this.abs(p)).catch(() => null);
    if (!st || st.isSymbolicLink()) return null;
    const n = normPath(p);
    return {
      name: n === '/' ? '' : n.slice(n.lastIndexOf('/') + 1),
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
    };
  }

  async read(p: string, start: number, end: number): Promise<Uint8Array> {
    const fh = await fs.open(this.abs(p), constants.O_RDONLY).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'ENOENT' ? new NotFoundError(p) : err;
    });
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

  async mkdir(p: string): Promise<void> {
    const st = await this.stat(p);
    if (st?.kind === 'dir') return;
    if (st) throw new ConflictError(`a file already exists at ${p}`);
    await fs.mkdir(this.abs(p), { recursive: true });
  }

  async move(from: string, to: string): Promise<void> {
    if (!(await this.stat(from))) throw new NotFoundError(from);
    if (await this.stat(to)) throw new ConflictError(`${to} already exists`);
    await fs.mkdir(path.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }

  async remove(p: string): Promise<void> {
    if (normPath(p) === '/') throw new Error('refusing to remove the backend root');
    await fs.rm(this.abs(p), { recursive: true, force: true });
  }

  private partPath(state: UploadState): string {
    const target = this.abs(String(state.path));
    return path.join(path.dirname(target), `${PART_PREFIX}${String(state.id)}`);
  }

  async beginUpload(p: string, size: number): Promise<UploadState> {
    const state = { path: normPath(p), size, id: randomUUID() };
    await fs.mkdir(path.dirname(this.abs(p)), { recursive: true });
    await fs.writeFile(this.partPath(state), new Uint8Array());
    return state;
  }

  async uploadedOffset(state: UploadState): Promise<number> {
    const st = await fs.stat(this.partPath(state)).catch(() => null);
    if (!st) {
      // Either never started or already finalised.
      const done = await this.stat(String(state.path));
      return done && done.size === state.size ? Number(state.size) : 0;
    }
    return st.size;
  }

  async uploadChunk(state: UploadState, offset: number, data: Uint8Array): Promise<void> {
    const part = this.partPath(state);
    const fh = await fs.open(part, constants.O_WRONLY | constants.O_CREAT);
    try {
      const st = await fh.stat();
      if (st.size < offset) throw new Error(`upload gap: have ${st.size}, got chunk at ${offset}`);
      await fh.truncate(offset);
      await fh.write(data, 0, data.length, offset);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (offset + data.length === Number(state.size)) {
      await fs.rename(part, this.abs(String(state.path)));
    }
  }

  async abortUpload(state: UploadState): Promise<void> {
    await fs.rm(this.partPath(state), { force: true });
  }
}
