// AI features against deterministic mock providers (Ollama and OpenAI-compatible).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiPlanSteps, aiSearchFilter, extractJson, makeProvider } from '../../src/server/ai/assistant.ts';
import type { App } from '../../src/server/app.ts';
import { aiSettings } from '../../src/shared/schemas.ts';
import { makeApp, serve, tmpDir, waitJobsIdle } from './helpers.ts';

let mock: http.Server;
let mockBase: string;
let reply = '{}';
let delayMs = 0;
let lastBody: { messages?: { content: string }[]; model?: string } = {};
let lastAuth: string | undefined;

beforeAll(async () => {
  mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    lastBody = raw ? JSON.parse(raw) : {};
    lastAuth = req.headers.authorization;
    await new Promise((r) => setTimeout(r, delayMs));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }));
    if (req.url === '/api/chat') return res.end(JSON.stringify({ message: { role: 'assistant', content: reply } }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
    if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => mock.close(() => r())));
beforeEach(() => {
  delayMs = 0;
});

const ollama = () => makeProvider(aiSettings.parse({ enabled: true, baseUrl: mockBase, model: 'llama3.2' }), null);

describe('providers', () => {
  it('talks to Ollama and OpenAI-compatible endpoints', async () => {
    expect(await ollama().models()).toEqual(['llama3.2:latest']);
    reply = '{"a":1}';
    expect(await ollama().chat([{ role: 'user', content: 'hi' }])).toBe('{"a":1}');
    const openai = makeProvider(aiSettings.parse({ enabled: true, provider: 'openai', baseUrl: `${mockBase}/v1`, model: 'gpt-test' }), 'sk-test');
    expect(await openai.chat([{ role: 'user', content: 'hi' }])).toBe('{"a":1}');
    expect(lastAuth).toBe('Bearer sk-test');
    expect(lastBody.model).toBe('gpt-test');
  });

  it('explains an unreachable provider', async () => {
    const p = makeProvider(aiSettings.parse({ enabled: true, baseUrl: 'http://127.0.0.1:9' }), null);
    await expect(p.models()).rejects.toThrow(/Cannot reach the AI provider.*ollama serve/);
  });

  it('times out slow providers', async () => {
    delayMs = 300;
    const p = makeProvider(aiSettings.parse({ enabled: true, baseUrl: mockBase, timeoutMs: 1000 }), null);
    const fast = makeProvider({ ...aiSettings.parse({ enabled: true, baseUrl: mockBase }), timeoutMs: 100 }, null);
    await expect(fast.models()).rejects.toThrow(/did not answer/);
    await expect(p.models()).resolves.toBeDefined();
  });

  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('Sure!\n```json\n{"x":2}\n```')).toEqual({ x: 2 });
    expect(() => extractJson('no json here')).toThrow(/did not return JSON/);
  });
});

describe('natural-language search', () => {
  it('turns a question into a validated filter', async () => {
    reply = '{"category":"video","minSize":10000000000,"sort":"size","order":"desc"}';
    const f = await aiSearchFilter(ollama(), 'videos over 10 GB');
    expect(f).toMatchObject({ category: 'video', minSize: 10_000_000_000, sort: 'size', limit: 50 });
    expect(lastBody.messages!.at(-1)!.content).toBe('videos over 10 GB');
  });

  it('rejects invalid filters from the model', async () => {
    reply = '{"category":"spaceships","minSize":-5}';
    await expect(aiSearchFilter(ollama(), 'x')).rejects.toThrow(/not valid/);
  });
});

describe('plans', () => {
  it('accepts well-formed plans', async () => {
    reply = JSON.stringify({ summary: 'Group stems', steps: [{ tool: 'mkdir', path: '/Music/stems' }, { tool: 'move', from: '/Music/a.wav', to: '/Music/stems/a.wav' }] });
    const plan = await aiPlanSteps(ollama(), 'group wavs', { cwd: '/Music', entries: [{ name: 'a.wav', kind: 'file', size: 1, modified: '2026-01-01' }] });
    expect(plan.steps).toHaveLength(2);
  });

  it('rejects plans with unknown tools or reserved paths', async () => {
    reply = JSON.stringify({ summary: 'x', steps: [{ tool: 'shell', command: 'rm -rf /' }] });
    await expect(aiPlanSteps(ollama(), 'x', { cwd: '/', entries: null })).rejects.toThrow(/not valid/);
    reply = JSON.stringify({ summary: 'x', steps: [{ tool: 'trash', path: '/.farshelf/vault.json' }] });
    await expect(aiPlanSteps(ollama(), 'x', { cwd: '/', entries: null })).rejects.toThrow(/forbidden path/);
    reply = JSON.stringify({ summary: 'x', steps: [{ tool: 'trash', path: '/../etc' }] });
    await expect(aiPlanSteps(ollama(), 'x', { cwd: '/', entries: null })).rejects.toThrow();
  });
});

describe('AI API endpoints', () => {
  let app: App;
  let base: string;
  let close: () => Promise<void>;
  let plainId: string;
  let encId: string;
  const api = (p: string, body?: unknown) =>
    fetch(base + p, { method: 'POST', headers: { cookie: `farshelf_session=${app.auth.apiToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

  beforeEach(async () => {
    ({ app } = await makeApp());
    ({ base, close } = await serve(app));
    app.start();
    plainId = (await app.createRemote({ kind: 'local', name: 'Plain', config: { root: await tmpDir() } })).remote.id;
    encId = (await app.createRemote({ kind: 'local', name: 'Enc', config: { root: await tmpDir() }, passphrase: 'a long passphrase' })).remote.id;
    await app.mkdir(plainId, '/Secret project name');
    await app.mkdir(encId, '/Secret project name');
    await waitJobsIdle(app);
    await app.updateSettings({ ai: { enabled: true, baseUrl: mockBase, model: 'llama3.2' } });
  });
  afterEach(async () => {
    await close();
    await app.close();
  });

  it('tests the provider connection', async () => {
    const out = await (await api('/api/ai/test')).json();
    expect(out).toMatchObject({ ok: true, modelAvailable: true, location: 'local' });
  });

  it('shares names only when asked, and never for encrypted remotes', async () => {
    reply = '{"summary":"nothing to do","steps":[]}';
    await api('/api/ai/plan', { request: 'tidy up', remoteId: plainId, cwd: '/', shareNames: false });
    expect(JSON.stringify(lastBody)).not.toContain('Secret project name');
    await api('/api/ai/plan', { request: 'tidy up', remoteId: plainId, cwd: '/', shareNames: true });
    expect(JSON.stringify(lastBody)).toContain('Secret project name');
    const res = await (await api('/api/ai/plan', { request: 'tidy up', remoteId: encId, cwd: '/', shareNames: true })).json();
    expect(JSON.stringify(lastBody)).not.toContain('Secret project name');
    expect(res.encryptedWithheld).toBe(true);
  });

  it('runs AI search locally against the index', async () => {
    reply = '{"text":"secret","kind":"dir"}';
    const out = await (await api('/api/ai/search', { question: 'the secret folder' })).json();
    expect(out.results.map((r: { remoteName: string }) => r.remoteName).sort()).toEqual(['Enc', 'Plain']);
  });

  it('does not execute anything itself: plans leave storage unchanged', async () => {
    reply = JSON.stringify({ summary: 'trash it', steps: [{ tool: 'trash', path: '/Secret project name' }] });
    const out = await (await api('/api/ai/plan', { request: 'delete everything', remoteId: plainId, cwd: '/', shareNames: true })).json();
    expect(out.plan.steps).toHaveLength(1);
    expect(await app.vault(plainId).stat('/Secret project name')).not.toBeNull();
  });
});
