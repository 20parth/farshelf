// Offline decryption of a local copy of an encrypted remote (e.g. a downloaded Google Drive folder).
import fs from 'node:fs/promises';
import path from 'node:path';
import { decryptSegment, HEADER_SIZE, openHeader, plainSize, segmentCount, segmentLocation } from './crypto/format.ts';
import { NameCipher, unlockWithPassphrase, unlockWithRecoveryKey, vaultDocSchema } from './crypto/keys.ts';
import { readFileRange } from './vault.ts';

export async function decryptTree(src: string, out: string, secret: { passphrase: string } | { recoveryKey: string }): Promise<number> {
  const doc = vaultDocSchema.parse(JSON.parse(await fs.readFile(path.join(src, '.farshelf', 'vault.json'), 'utf8')));
  const master = 'passphrase' in secret ? await unlockWithPassphrase(doc, secret.passphrase) : unlockWithRecoveryKey(doc, secret.recoveryKey);
  const names = new NameCipher(master);
  let count = 0;

  async function walk(dir: string, target: string): Promise<void> {
    await fs.mkdir(target, { recursive: true });
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.farshelf')) continue;
      let name: string;
      try {
        name = names.decrypt(ent.name);
      } catch {
        console.warn(`skipping ${path.join(dir, ent.name)} (not encrypted with this key)`);
        continue;
      }
      if (name.includes('/') || name === '..' || name === '.') throw new Error('refusing unsafe decrypted name');
      const from = path.join(dir, ent.name);
      const to = path.join(target, name);
      if (ent.isDirectory()) await walk(from, to);
      else if (ent.isFile()) {
        await decryptFile(master, from, to);
        count++;
      }
    }
  }

  await walk(src, out);
  return count;
}

export async function decryptFile(master: Buffer, from: string, to: string): Promise<void> {
  const { size: cipher } = await fs.stat(from);
  const size = plainSize(cipher);
  const fc = openHeader(master, await readFileRange(from, 0, HEADER_SIZE));
  const fh = await fs.open(to, 'w', 0o600);
  try {
    const n = segmentCount(size);
    for (let i = 0; i < n; i++) {
      const loc = segmentLocation(i, size);
      const sealed = await readFileRange(from, loc.offset, loc.offset + loc.length);
      await fh.write(decryptSegment(fc, i, i === n - 1, sealed));
    }
  } finally {
    await fh.close();
  }
}
