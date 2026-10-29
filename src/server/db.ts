import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  create table meta (key text primary key, value text not null);
  create table settings (key text primary key, value text not null);
  create table secrets (key text primary key, value text not null);
  create table remotes (
    id text primary key,
    name text not null unique,
    kind text not null,
    config text not null,
    encrypted integer not null default 0,
    created_at integer not null
  );
  create table entries (
    remote_id text not null references remotes(id) on delete cascade,
    path text not null,
    parent text not null,
    name text not null,
    kind text not null,
    size integer not null,
    mtime integer not null,
    indexed_at integer not null,
    primary key (remote_id, path)
  );
  create index entries_parent on entries(remote_id, parent);
  create virtual table entries_fts using fts5(name, path, content='entries', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
  create trigger entries_ai after insert on entries begin
    insert into entries_fts(rowid, name, path) values (new.rowid, new.name, new.path);
  end;
  create trigger entries_ad after delete on entries begin
    insert into entries_fts(entries_fts, rowid, name, path) values ('delete', old.rowid, old.name, old.path);
  end;
  create trigger entries_au after update on entries begin
    insert into entries_fts(entries_fts, rowid, name, path) values ('delete', old.rowid, old.name, old.path);
    insert into entries_fts(rowid, name, path) values (new.rowid, new.name, new.path);
  end;
  create table jobs (
    id text primary key,
    kind text not null,
    remote_id text not null,
    state text not null,
    label text not null,
    path text not null,
    payload text not null,
    progress integer not null default 0,
    total integer not null default 0,
    error text,
    attempts integer not null default 0,
    next_run_at integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  create index jobs_state on jobs(state);
  create table trash (
    id text primary key,
    remote_id text not null references remotes(id) on delete cascade,
    original_path text not null,
    name text not null,
    kind text not null,
    size integer not null,
    trashed_at integer not null
  );
  create table activity (
    id integer primary key autoincrement,
    ts integer not null,
    level text not null,
    remote_id text,
    action text not null,
    path text,
    message text not null
  );
  create virtual table activity_fts using fts5(action, path, message, content='activity', content_rowid='id');
  create trigger activity_ai after insert on activity begin
    insert into activity_fts(rowid, action, path, message) values (new.id, new.action, coalesce(new.path, ''), new.message);
  end;
  create trigger activity_ad after delete on activity begin
    insert into activity_fts(activity_fts, rowid, action, path, message) values ('delete', old.id, old.action, coalesce(old.path, ''), old.message);
  end;
  `,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('create table if not exists schema_version (version integer not null)');
  const row = db.prepare('select version from schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('insert into schema_version (version) values (0)').run();
  while (version < MIGRATIONS.length) {
    db.exec('begin');
    try {
      db.exec(MIGRATIONS[version]!);
      version += 1;
      db.prepare('update schema_version set version = ?').run(version);
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('begin');
  try {
    const out = fn();
    db.exec('commit');
    return out;
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
}
