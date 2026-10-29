// Secret storage: macOS Keychain or Linux Secret Service when available, otherwise the local database.
import { execFile, spawn } from 'node:child_process';
import type { Db } from './db.ts';

const SERVICE = 'Farshelf';

export interface SecretStore {
  /** 'macos-keychain' | 'secret-service' | 'database' | 'memory' */
  readonly kind: string;
  /** Whether secrets survive a restart in an OS-protected store. */
  readonly secure: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(input ?? '');
  });
}

const safeKey = (k: string) => {
  if (!/^[\w:.-]+$/.test(k)) throw new Error(`invalid secret key ${k}`);
  return k;
};

class MacKeychain implements SecretStore {
  readonly kind = 'macos-keychain';
  readonly secure = true;
  async get(key: string) {
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', safeKey(key), '-w']);
    if (r.code !== 0) return null;
    return Buffer.from(r.stdout.trim(), 'hex').toString('utf8');
  }
  async set(key: string, value: string) {
    // Pass the secret on stdin (interactive mode) so it never appears in the process list.
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const r = await run('/usr/bin/security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${safeKey(key)} -w ${hex}\n`);
    if (r.code !== 0) throw new Error('could not write to the macOS keychain');
  }
  async delete(key: string) {
    await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', safeKey(key)]);
  }
}

class SecretService implements SecretStore {
  readonly kind = 'secret-service';
  readonly secure = true;
  async get(key: string) {
    const r = await run('secret-tool', ['lookup', 'service', 'farshelf', 'key', safeKey(key)]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }
  async set(key: string, value: string) {
    const r = await run('secret-tool', ['store', '--label', `Farshelf ${key}`, 'service', 'farshelf', 'key', safeKey(key)], value);
    if (r.code !== 0) throw new Error('could not write to the Secret Service keyring');
  }
  async delete(key: string) {
    await run('secret-tool', ['clear', 'service', 'farshelf', 'key', safeKey(key)]);
  }
}

class DbSecrets implements SecretStore {
  readonly kind = 'database';
  readonly secure = false;
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async get(key: string) {
    const row = this.db.prepare('select value from secrets where key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  async set(key: string, value: string) {
    this.db.prepare('insert into secrets (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
  }
  async delete(key: string) {
    this.db.prepare('delete from secrets where key = ?').run(key);
  }
}

export class MemorySecrets implements SecretStore {
  readonly kind = 'memory';
  readonly secure = false;
  private readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

function hasSecretTool(): Promise<boolean> {
  return new Promise((resolve) => execFile('secret-tool', ['--version'], (err) => resolve(!err)));
}

/** mode: 'auto' (default) | 'database' | 'memory' — tests use 'memory' so they never touch the real keychain. */
export async function openSecretStore(db: Db, mode = process.env.FARSHELF_KEYCHAIN ?? 'auto'): Promise<SecretStore> {
  if (mode === 'memory') return new MemorySecrets();
  if (mode === 'database') return new DbSecrets(db);
  if (process.platform === 'darwin') return new MacKeychain();
  if (process.platform === 'linux' && (await hasSecretTool())) return new SecretService();
  return new DbSecrets(db);
}
