import os from 'node:os';
import path from 'node:path';

/** Directory for Farshelf's database, spool and token. Override with FARSHELF_HOME. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FARSHELF_HOME) return path.resolve(env.FARSHELF_HOME);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Farshelf');
  if (process.platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Farshelf');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'farshelf');
}

/** Normalise a remote path: leading slash, no trailing slash (except root), no empty segments. */
export function normPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.some((s) => s === '..' || s === '.')) throw new Error(`invalid path: ${p}`);
  return '/' + parts.join('/');
}

export function parentOf(p: string): string {
  const n = normPath(p);
  if (n === '/') return '/';
  return n.slice(0, n.lastIndexOf('/')) || '/';
}

export function baseName(p: string): string {
  const n = normPath(p);
  return n.slice(n.lastIndexOf('/') + 1);
}

export function joinPath(dir: string, name: string): string {
  if (!name || name.includes('/') || name === '.' || name === '..') throw new Error(`invalid name: ${name}`);
  const d = normPath(dir);
  return d === '/' ? `/${name}` : `${d}/${name}`;
}

/** True if `child` is `ancestor` or inside it. */
export function isWithin(child: string, ancestor: string): boolean {
  const c = normPath(child);
  const a = normPath(ancestor);
  return a === '/' || c === a || c.startsWith(a + '/');
}
