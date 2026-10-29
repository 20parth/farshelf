import { EventEmitter } from 'node:events';
import type { ActivityItem } from '../shared/schemas.ts';
import type { Db } from './db.ts';

export class ActivityLog extends EventEmitter {
  private readonly db: Db;
  constructor(db: Db) {
    super();
    this.db = db;
  }

  add(
    level: ActivityItem['level'],
    action: string,
    message: string,
    opts: { remoteId?: string | null; path?: string | null } = {},
  ) {
    const ts = Date.now();
    const r = this.db
      .prepare('insert into activity (ts, level, remote_id, action, path, message) values (?, ?, ?, ?, ?, ?)')
      .run(ts, level, opts.remoteId ?? null, action, opts.path ?? null, message);
    const item: ActivityItem = {
      id: Number(r.lastInsertRowid),
      ts,
      level,
      remoteId: opts.remoteId ?? null,
      action,
      path: opts.path ?? null,
      message,
    };
    this.emit('activity', item);
    return item;
  }

  list(query: string | undefined, limit = 200): ActivityItem[] {
    const cols = 'a.id, a.ts, a.level, a.remote_id as remoteId, a.action, a.path, a.message';
    const q = query?.trim();
    if (q) {
      return this.db
        .prepare(
          `select ${cols} from activity_fts f join activity a on a.id = f.rowid where activity_fts match ? order by a.id desc limit ?`,
        )
        .all(ftsQuery(q), limit) as unknown as ActivityItem[];
    }
    return this.db
      .prepare(`select ${cols} from activity a order by a.id desc limit ?`)
      .all(limit) as unknown as ActivityItem[];
  }
}

/** Turn free text into a safe FTS5 prefix query: every token quoted, AND-ed, with prefix match. */
export function ftsQuery(text: string): string {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!tokens.length) return '""';
  return tokens.map((t) => `"${t}"*`).join(' ');
}
