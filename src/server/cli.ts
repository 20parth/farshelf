#!/usr/bin/env node
// Farshelf command-line entry point.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';

// node:sqlite still prints an ExperimentalWarning on some Node versions; it is expected, so keep the console clean.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(w instanceof Error ? w.message : w).includes('SQLite')) return;
  return (emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const HELP = `Farshelf — your storage, streamed like a local disk.

Usage:
  farshelf start [--port 7420] [--host 127.0.0.1] [--no-open]   Start the daemon and open the UI
  farshelf url                                                  Print the login link for the running daemon
  farshelf decrypt <encrypted-folder> <output-folder>           Decrypt a local copy of an encrypted remote
                   [--recovery-key]                             (prompts for passphrase or recovery key)
  farshelf reset --yes                                          Delete all Farshelf data on this machine
                                                                (your remote files are not touched)
Environment:
  FARSHELF_HOME   data directory (default: OS app-data folder)
  FARSHELF_PORT   port (default 7420)       FARSHELF_HOST   bind address (default 127.0.0.1)
`;

async function main(): Promise<void> {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { defaultDataDir } = await import('./paths.ts');
  const dataDir = defaultDataDir();

  if (cmd === 'start') {
    const { values } = parseArgs({
      args: rest,
      options: { port: { type: 'string' }, host: { type: 'string' }, 'no-open': { type: 'boolean' } },
    });
    const port = Number(values.port ?? process.env.FARSHELF_PORT ?? 7420);
    const host = values.host ?? process.env.FARSHELF_HOST ?? '127.0.0.1';
    const { App } = await import('./app.ts');
    const { createServer } = await import('./http/server.ts');
    const display = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const baseUrl = `http://${display.includes(':') ? `[${display}]` : display}:${port}`;
    const app = await App.open({ dataDir, baseUrl });
    const devOrigin = process.env.FARSHELF_DEV_ORIGIN;
    const extraHosts = (process.env.FARSHELF_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) extraHosts.push(`${host}:${port}`);
    const server = createServer(app, { extraOrigins: devOrigin ? [devOrigin] : [], extraHosts });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    app.start();
    const login = `${baseUrl}/login#t=${app.auth.apiToken}`;
    console.log(`Farshelf ${(await import('./app.ts')).VERSION} running at ${baseUrl}`);
    console.log(`Data directory: ${dataDir}`);
    console.log(`Secrets stored in: ${app.secrets.kind}${app.secrets.secure ? '' : ' (not an OS keychain; encrypted remotes must be unlocked after each restart)'}`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      console.warn(`WARNING: listening on ${host}. Anyone who can reach this port and has the credentials can read your files. Put it behind TLS.`);
    }
    console.log(`\nOpen this link to sign in to the UI (keep it private):\n  ${login}\n`);
    console.log(`Mount in your file manager: ${baseUrl}/dav/  (user: farshelf, password shown in Settings › Mount)`);
    if (!values['no-open']) openBrowser(login);
    const shutdown = async () => {
      console.log('\nStopping Farshelf…');
      server.close();
      server.closeAllConnections();
      await app.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (cmd === 'url') {
    try {
      const auth = JSON.parse(await fs.readFile(path.join(dataDir, 'auth.json'), 'utf8'));
      const port = Number(process.env.FARSHELF_PORT ?? 7420);
      console.log(`http://127.0.0.1:${port}/login#t=${auth.apiToken}`);
    } catch {
      console.error('No Farshelf data found. Run `farshelf start` first.');
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'decrypt') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'recovery-key': { type: 'boolean' } } });
    const [src, out] = positionals;
    if (!src || !out) {
      console.error('Usage: farshelf decrypt <encrypted-folder> <output-folder>');
      process.exitCode = 1;
      return;
    }
    const secret = process.env.FARSHELF_PASSPHRASE ?? (await prompt(values['recovery-key'] ? 'Recovery key: ' : 'Passphrase: '));
    const { decryptTree } = await import('./decrypt.ts');
    const n = await decryptTree(path.resolve(src), path.resolve(out), values['recovery-key'] ? { recoveryKey: secret } : { passphrase: secret });
    console.log(`Decrypted ${n} file(s) into ${path.resolve(out)}`);
    return;
  }

  if (cmd === 'reset') {
    if (!rest.includes('--yes')) {
      console.error(`This deletes ${dataDir} (settings, index, queued uploads, stored sign-ins). Re-run with --yes to confirm.`);
      process.exitCode = 1;
      return;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
    console.log(`Deleted ${dataDir}. Keychain entries named "Farshelf" can be removed with your keychain app.`);
    return;
  }

  console.log(HELP);
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    // Hide typed characters.
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    out._writeToOutput = (s: string) => {
      if (s.startsWith(question)) process.stdout.write(question);
    };
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
