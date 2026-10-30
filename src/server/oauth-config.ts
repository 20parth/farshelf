// The Google OAuth client Farshelf signs in with when the user does not supply their own.
// Publishers set it once (env vars or google-oauth.json at the package root, written by the release build),
// so end users only see "Sign in with Google".
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface GoogleClient {
  clientId: string;
  clientSecret?: string;
  source: 'env' | 'file';
}

const fileSchema = z.object({
  clientId: z
    .string()
    .regex(/\.apps\.googleusercontent\.com$/, 'clientId must end with .apps.googleusercontent.com'),
  clientSecret: z.string().optional(),
});

/** Walk up from this module to the directory holding Farshelf's package.json. */
function packageRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'farshelf') return dir;
      } catch {
        // keep walking
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

export function builtinGoogleClient(
  env: NodeJS.ProcessEnv = process.env,
  file?: string,
): GoogleClient | null {
  if (env.FARSHELF_GDRIVE_CLIENT_ID) {
    return {
      clientId: env.FARSHELF_GDRIVE_CLIENT_ID,
      clientSecret: env.FARSHELF_GDRIVE_CLIENT_SECRET || undefined,
      source: 'env',
    };
  }
  const root = packageRoot();
  const candidate = file ?? (root ? path.join(root, 'google-oauth.json') : null);
  if (!candidate || !existsSync(candidate)) return null;
  try {
    const parsed = fileSchema.parse(JSON.parse(readFileSync(candidate, 'utf8')));
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret || undefined, source: 'file' };
  } catch (err) {
    console.warn(`[farshelf] ignoring ${candidate}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
