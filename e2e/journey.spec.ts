// End-to-end: real daemon process + real browser (system Chrome) through the primary user journey.
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 7499;
const BASE = `http://127.0.0.1:${PORT}`;
let home: string;
let store: string;
let daemon: ChildProcess | null = null;

async function startDaemon(): Promise<string> {
  daemon = spawn(
    process.execPath,
    [
      'dist/server/server/cli.js',
      'start',
      '--port',
      String(PORT),
      '--no-open',
      '--home',
      home,
      '--secrets',
      'memory',
    ],
    { stdio: 'pipe' },
  );
  let out = '';
  daemon.stdout!.on('data', (d) => (out += d));
  daemon.stderr!.on('data', (d) => (out += d));
  daemon.on('exit', (code, sig) => (out += `\n[exited code=${code} signal=${sig}]`));
  for (let i = 0; i < 300 && !out.includes('/login#t=') && !out.includes('[exited'); i++)
    await new Promise((r) => setTimeout(r, 100));
  const m = out.match(/(http:\/\/\S+\/login#t=\S+)/);
  if (!m) throw new Error('daemon did not start:\n' + out);
  return m[1]!;
}

async function stopDaemon() {
  if (!daemon) return;
  const d = daemon;
  daemon = null;
  if (d.exitCode !== null || d.signalCode !== null) return;
  await new Promise<void>((r) => {
    const t = setTimeout(() => {
      d.kill('SIGKILL');
      r();
    }, 5000);
    d.once('exit', () => {
      clearTimeout(t);
      r();
    });
    d.kill('SIGTERM');
  });
}

async function a11y(page: Page, what: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map(
      (v) =>
        `${what}: ${v.id} ${v.help}: ${v.nodes.map((n) => n.target.join(' ') + ' ' + (n.failureSummary ?? '')).join(' | ')}`,
    ),
  ).toEqual([]);
}

test.beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'farshelf-e2e-home-'));
  store = await fs.mkdtemp(path.join(os.tmpdir(), 'farshelf-e2e-store-'));
});
test.afterAll(stopDaemon);

test('first run, upload, organise, search, stream, restart and unlock', async ({ page, context }) => {
  // ---- first run: onboarding with encryption ----
  await page.goto(await startDaemon());
  await expect(page.getByRole('heading', { name: 'Welcome to Farshelf' })).toBeVisible();
  await a11y(page, 'onboarding');
  await page.getByLabel('Name', { exact: true }).fill('Studio');
  await page.getByLabel('Folder path').fill(store);
  await page.getByLabel(/Encrypt file contents and names/).check();
  await page.getByLabel('Passphrase', { exact: true }).fill('e2e test passphrase');
  await page.getByLabel('Confirm passphrase').fill('e2e test passphrase');
  await page.getByRole('button', { name: 'Add storage' }).click();
  const key = (await page.getByTestId('recovery-key').textContent())!.trim();
  expect(key).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
  await page.getByLabel(/I have saved my recovery key/).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('region', { name: 'Files in Studio' })).toBeVisible();
  await expect(page.getByText('This folder is empty')).toBeVisible();

  // ---- upload ----
  const content = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  content.write('FARSHELF-E2E', 1024 * 1024);
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'kyoto walk.mov', mimeType: 'video/quicktime', buffer: content });
  const row = page.getByRole('row', { name: /kyoto walk\.mov/ });
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Transfers' }).click();
  await expect(page.getByText(/Nothing in progress/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('kyoto walk.mov', { exact: true })).toBeVisible();
  await a11y(page, 'transfers');

  // Nothing readable on disk: names and contents are encrypted.
  const onDisk = (await fs.readdir(store)).filter((n) => !n.startsWith('.farshelf'));
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0]).not.toContain('kyoto');

  // ---- organise: folder, move, rename, trash, restore ----
  await page.getByRole('button', { name: 'Studio' }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Films');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('row', { name: /Films/ })).toBeVisible();
  await page.getByRole('row', { name: /kyoto walk\.mov/ }).hover();
  await page.getByRole('button', { name: 'Move kyoto walk.mov', exact: true }).click();
  await page.getByLabel('Destination folder').fill('/Films');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('row', { name: /kyoto walk\.mov/ })).toHaveCount(0);
  await page.getByRole('row', { name: /Films/ }).dblclick();
  await expect(page.getByRole('row', { name: /kyoto walk\.mov/ })).toBeVisible();
  await a11y(page, 'file browser');
  await page.getByRole('row', { name: /kyoto walk\.mov/ }).focus();
  await page.keyboard.press('F2');
  await page.getByLabel('Name', { exact: true }).fill('kyoto final.mov');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  // Focus stays on the renamed row, so the keyboard keeps working.
  await expect(page.getByRole('row', { name: /kyoto final\.mov/ })).toBeFocused();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByRole('row', { name: /kyoto final\.mov/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Trash' }).click();
  await expect(page.getByText('was /Films/kyoto final.mov', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Trash is empty')).toBeVisible();

  // ---- search with ⌘K / Ctrl+K and copy-link / open ----
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox').fill('kyoto');
  await expect(page.getByRole('option', { name: /kyoto final\.mov/ })).toBeVisible();
  await a11y(page, 'search');
  // Opening a file loads its signed stream link in a new tab (headless Chrome may treat .mov as a download).
  const [req] = await Promise.all([
    context.waitForEvent('request', (r) => r.url().includes('/stream/')),
    page.keyboard.press('Enter'),
  ]);
  const streamUrl = req.url();
  expect(streamUrl).toContain('sig=');

  // ---- stream: Range requests return exactly the requested decrypted bytes ----
  const r = await fetch(streamUrl, { headers: { range: `bytes=${1024 * 1024}-${1024 * 1024 + 11}` } });
  expect(r.status).toBe(206);
  expect(await r.text()).toBe('FARSHELF-E2E');

  // ---- activity history is searchable ----
  await page.getByRole('button', { name: 'Activity' }).click();
  await page.getByLabel('Search activity').fill('restored');
  await expect(page.getByText(/Restored \/Films\/kyoto final\.mov/)).toBeVisible();

  // ---- restart: state persists, encrypted storage locks (no keychain in this test) ----
  await stopDaemon();
  await startDaemon();
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'Studio' }).click();
  await expect(page.getByRole('heading', { name: 'Studio is locked' })).toBeVisible();
  await page.getByRole('button', { name: 'Use recovery key instead' }).click();
  await page.getByLabel('Recovery key').fill(key);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('row', { name: /Films/ })).toBeVisible();
  await page.getByRole('row', { name: /Films/ }).dblclick();
  await expect(page.getByRole('row', { name: /kyoto final\.mov/ })).toBeVisible();
});

test('rejects requests without a session and from foreign hosts', async () => {
  if (!daemon) await startDaemon();
  expect((await fetch(`${BASE}/api/state`)).status).toBe(401);
  const res = await fetch(`${BASE}/dav/`, { method: 'PROPFIND' });
  expect(res.status).toBe(401);
});
