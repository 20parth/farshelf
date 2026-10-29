// Master-key wrapping (passphrase + recovery key) and deterministic name encryption.
import { createHmac, hkdfSync, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { aesGcmDecrypt, aesGcmEncrypt, DecryptError } from './format.ts';

const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

const wrapSchema = z.object({ nonce: z.string(), ct: z.string() });
export const vaultDocSchema = z.object({
  format: z.literal('farshelf-vault'),
  version: z.literal(1),
  kdf: z.object({
    alg: z.literal('scrypt'),
    N: z.number().int(),
    r: z.number().int(),
    p: z.number().int(),
    salt: z.string(),
  }),
  passphrase: wrapSchema,
  recovery: wrapSchema,
});
export type VaultDoc = z.infer<typeof vaultDocSchema>;

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');
const AAD = Buffer.from('farshelf-vault-v1');

function scrypt(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(
      passphrase.normalize('NFKC'),
      salt,
      32,
      { ...params, maxmem: 256 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

function recoveryWrapKey(recovery: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', recovery, Buffer.alloc(0), 'farshelf recovery wrap v1', 32));
}

function wrap(key: Buffer, secret: Buffer) {
  const nonce = randomBytes(12);
  return { nonce: b64(nonce), ct: b64(aesGcmEncrypt(key, nonce, secret, AAD)) };
}

export function encodeRecoveryKey(bytes: Buffer): string {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{1,4}/g)!.join('-');
}

export function decodeRecoveryKey(text: string): Buffer {
  const clean = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== 52) throw new DecryptError('a recovery key has 52 characters');
  let bits = '';
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new DecryptError(`invalid character in recovery key: ${ch}`);
    bits += v.toString(2).padStart(5, '0');
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

/** Create a new vault: random master key wrapped by the passphrase and by a fresh recovery key. */
export async function createVault(
  passphrase: string,
  params: { N: number; r: number; p: number } = SCRYPT,
): Promise<{ doc: VaultDoc; masterKey: Buffer; recoveryKey: string }> {
  const masterKey = randomBytes(32);
  const recovery = randomBytes(32);
  const salt = randomBytes(16);
  const passKey = await scrypt(passphrase, salt, params);
  const doc: VaultDoc = {
    format: 'farshelf-vault',
    version: 1,
    kdf: { alg: 'scrypt', ...params, salt: b64(salt) },
    passphrase: wrap(passKey, masterKey),
    recovery: wrap(recoveryWrapKey(recovery), masterKey),
  };
  return { doc, masterKey, recoveryKey: encodeRecoveryKey(recovery) };
}

export async function unlockWithPassphrase(doc: VaultDoc, passphrase: string): Promise<Buffer> {
  const key = await scrypt(passphrase, unb64(doc.kdf.salt), doc.kdf);
  try {
    return aesGcmDecrypt(key, unb64(doc.passphrase.nonce), unb64(doc.passphrase.ct), AAD);
  } catch {
    throw new DecryptError('wrong passphrase');
  }
}

export function unlockWithRecoveryKey(doc: VaultDoc, recoveryKey: string): Buffer {
  const key = recoveryWrapKey(decodeRecoveryKey(recoveryKey));
  try {
    return aesGcmDecrypt(key, unb64(doc.recovery.nonce), unb64(doc.recovery.ct), AAD);
  } catch {
    throw new DecryptError('wrong recovery key');
  }
}

/** Re-wrap the master key with a new passphrase (files are not re-encrypted). */
export async function changePassphrase(doc: VaultDoc, masterKey: Buffer, passphrase: string): Promise<VaultDoc> {
  const salt = randomBytes(16);
  const params = { N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p };
  const key = await scrypt(passphrase, salt, params);
  return { ...doc, kdf: { alg: 'scrypt', ...params, salt: b64(salt) }, passphrase: wrap(key, masterKey) };
}

/** Deterministic (SIV-style) name encryption so a plaintext path always maps to the same remote path. */
export class NameCipher {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(masterKey: Buffer) {
    const okm = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'farshelf names v1', 64));
    this.encKey = okm.subarray(0, 32);
    this.macKey = okm.subarray(32);
  }

  encrypt(name: string): string {
    const plain = Buffer.from(name.normalize('NFC'), 'utf8');
    const nonce = createHmac('sha256', this.macKey).update(plain).digest().subarray(0, 12);
    const out = Buffer.concat([nonce, aesGcmEncrypt(this.encKey, nonce, plain)]).toString('base64url');
    if (out.length > 255) throw new Error(`name too long for an encrypted remote: ${name}`);
    return out;
  }

  decrypt(encoded: string): string {
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.length < 12 + 16 || raw.toString('base64url') !== encoded) throw new DecryptError('not an encrypted name');
    const nonce = raw.subarray(0, 12);
    const plain = aesGcmDecrypt(this.encKey, nonce, raw.subarray(12));
    const expected = createHmac('sha256', this.macKey).update(plain).digest().subarray(0, 12);
    if (!timingSafeEqual(nonce, expected)) throw new DecryptError('name nonce mismatch');
    return plain.toString('utf8');
  }
}
