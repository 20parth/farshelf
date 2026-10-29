// Local metadata index (names, sizes, dates) used for search. File contents are never indexed.
import type { Entry, SearchFilter, SearchResult } from '../shared/schemas.ts';
import { ftsQuery } from './activity.ts';
import { tx, type Db } from './db.ts';
import { normPath } from './paths.ts';

export const CATEGORY_EXTENSIONS: Record<string, string[]> = {
  video: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'mxf', 'braw', 'r3d', 'mts', 'm2ts', 'wmv', 'flv', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'aiff', 'aif', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'alac', 'wma'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'tiff', 'tif', 'bmp', 'svg', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'psd'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'md', 'rtf', 'pages', 'numbers', 'key', 'csv', 'epub'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso', 'sparsebundle'],
  code: ['js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'swift', 'kt', 'sh', 'json', 'yaml', 'yml', 'toml', 'html', 'css'],
};

export class Catalog {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Replace the indexed children of `dir` with a fresh listing (removing vanished subtrees). */
  putListing(remoteId: string, dir: string, entries: Entry[]): void {
    const parent = normPath(dir);
    const now = Date.now();
    tx(this.db, () => {
      const existing = this.db
        .prepare('select path, kind from entries where remote_id = ? and parent = ?')
        .all(remoteId, parent) as { path: string; kind: string }[];
      const keep = new Set(entries.filter((e) => !e.pending).map((e) => e.path));
      for (const old of existing) if (!keep.has(old.path)) this.removeTree(remoteId, old.path);
      const up = this.db.prepare(
        `insert into entries (remote_id, path, parent, name, kind, size, mtime, indexed_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(remote_id, path) do update set kind = excluded.kind, size = excluded.size, mtime = excluded.mtime, indexed_at = excluded.indexed_at
         where entries.kind != excluded.kind or entries.size != excluded.size or entries.mtime != excluded.mtime`,
      );
      for (const e of entries) {
        if (e.pending) continue;
        up.run(remoteId, e.path, parent, e.name, e.kind, e.size, Math.round(e.mtime), now);
      }
    });
  }

  upsert(remoteId: string, e: Entry): void {
    const path = normPath(e.path);
    const parent = path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/';
    this.db
      .prepare(
        `insert into entries (remote_id, path, parent, name, kind, size, mtime, indexed_at) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(remote_id, path) do update set kind = excluded.kind, size = excluded.size, mtime = excluded.mtime, indexed_at = excluded.indexed_at`,
      )
      .run(remoteId, path, parent, e.name, e.kind, e.size, Math.round(e.mtime), Date.now());
  }

  removeTree(remoteId: string, path: string): void {
    const p = normPath(path);
    this.db.prepare('delete from entries where remote_id = ? and (path = ? or path like ? escape \'\\\')').run(remoteId, p, likePrefix(p));
  }

  /** Re-key a moved subtree. */
  moveTree(remoteId: string, from: string, to: string): void {
    const a = normPath(from);
    const b = normPath(to);
    tx(this.db, () => {
      const rows = this.db
        .prepare(`select path, kind, size, mtime from entries where remote_id = ? and (path = ? or path like ? escape '\\')`)
        .all(remoteId, a, likePrefix(a)) as { path: string; kind: 'file' | 'dir'; size: number; mtime: number }[];
      this.removeTree(remoteId, b);
      this.removeTree(remoteId, a);
      for (const r of rows) {
        const np = b + r.path.slice(a.length);
        this.upsert(remoteId, { path: np, name: np.slice(np.lastIndexOf('/') + 1), kind: r.kind, size: r.size, mtime: r.mtime });
      }
    });
  }

  count(remoteId?: string): number {
    const row = (remoteId
      ? this.db.prepare('select count(*) as n from entries where remote_id = ?').get(remoteId)
      : this.db.prepare('select count(*) as n from entries').get()) as { n: number };
    return row.n;
  }

  search(f: SearchFilter): SearchResult[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    let from = 'entries e';
    const text = f.text?.trim();
    if (text) {
      from = 'entries_fts fts join entries e on e.rowid = fts.rowid';
      where.push('entries_fts match ?');
      args.push(`name : (${ftsQuery(text)})`);
    }
    if (f.remoteId) {
      where.push('e.remote_id = ?');
      args.push(f.remoteId);
    }
    if (f.kind) {
      where.push('e.kind = ?');
      args.push(f.kind);
    }
    const exts = [...(f.extensions ?? []), ...(f.category ? CATEGORY_EXTENSIONS[f.category] ?? [] : [])].map((x) =>
      x.toLowerCase().replace(/^\./, ''),
    );
    if (exts.length) {
      where.push(`(${exts.map(() => 'lower(e.name) like ?').join(' or ')})`);
      args.push(...exts.map((x) => `%.${x}`));
    }
    if (f.minSize !== undefined) {
      where.push('e.size >= ?');
      args.push(f.minSize);
    }
    if (f.maxSize !== undefined) {
      where.push('e.size <= ?');
      args.push(f.maxSize);
    }
    if (f.modifiedAfter) {
      where.push('e.mtime >= ?');
      args.push(Date.parse(f.modifiedAfter));
    }
    if (f.modifiedBefore) {
      where.push('e.mtime < ?');
      args.push(Date.parse(f.modifiedBefore) + 86_400_000);
    }
    if (f.pathPrefix && normPath(f.pathPrefix) !== '/') {
      where.push(`e.path like ? escape '\\'`);
      args.push(likePrefix(normPath(f.pathPrefix)));
    }
    const order =
      f.sort === 'relevance' && text
        ? 'fts.rank'
        : f.sort === 'name'
          ? `e.name collate nocase ${f.order}`
          : f.sort === 'size'
            ? `e.size ${f.order}`
            : `e.mtime ${f.order}`;
    const sql = `select e.remote_id as remoteId, r.name as remoteName, e.path, e.name, e.kind, e.size, e.mtime
      from ${from} join remotes r on r.id = e.remote_id
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by ${order} limit ?`;
    return this.db.prepare(sql).all(...args, f.limit) as unknown as SearchResult[];
  }
}

function likePrefix(p: string): string {
  return p.replace(/[\\%_]/g, (c) => '\\' + c) + '/%';
}
