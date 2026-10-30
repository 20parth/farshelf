import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinGoogleClient } from '../../src/server/oauth-config.ts';
import { makeApp, serve, tmpDir } from './helpers.ts';

const ID = '1234-abc.apps.googleusercontent.com';

describe('built-in Google client', () => {
  afterEach(() => {
    delete process.env.FARSHELF_GDRIVE_CLIENT_ID;
    delete process.env.FARSHELF_GDRIVE_CLIENT_SECRET;
  });

  it('reads env vars first, then a google-oauth.json file', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'google-oauth.json');
    expect(builtinGoogleClient({}, file)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ clientId: ID, clientSecret: 'GOCSPX-x' }));
    expect(builtinGoogleClient({}, file)).toEqual({ clientId: ID, clientSecret: 'GOCSPX-x', source: 'file' });
    expect(builtinGoogleClient({ FARSHELF_GDRIVE_CLIENT_ID: 'env-id' }, file)).toMatchObject({
      clientId: 'env-id',
      source: 'env',
    });
  });

  it('ignores a malformed file', async () => {
    const file = path.join(await tmpDir(), 'google-oauth.json');
    await fs.writeFile(file, JSON.stringify({ clientId: 'not-a-client' }));
    expect(builtinGoogleClient({}, file)).toBeNull();
  });

  it('lets end users sign in with no fields when a built-in client exists', async () => {
    const { app } = await makeApp();
    const { base, close } = await serve(app);
    const post = (body: unknown) =>
      fetch(`${base}/api/oauth/google/start`, {
        method: 'POST',
        headers: { cookie: `farshelf_session=${app.auth.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const without = await post({});
      expect(without.status).toBe(400);
      expect((await without.json()).message).toMatch(/no built-in Google sign-in/);

      process.env.FARSHELF_GDRIVE_CLIENT_ID = ID;
      const state = await (
        await fetch(`${base}/api/state`, { headers: { cookie: `farshelf_session=${app.auth.apiToken}` } })
      ).json();
      expect(state.googleSignIn).toBe('builtin');
      const { authUrl } = await (await post({})).json();
      const u = new URL(authUrl);
      expect(u.searchParams.get('client_id')).toBe(ID);
      expect(u.searchParams.get('redirect_uri')).toBe(`${base}/oauth/callback`);

      // A client typed in under "Advanced" still wins.
      const own = await (await post({ clientId: 'own-client-id-123' })).json();
      expect(new URL(own.authUrl).searchParams.get('client_id')).toBe('own-client-id-123');
    } finally {
      await close();
      await app.close();
    }
  });
});
