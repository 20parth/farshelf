import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ciphertextRange,
  decryptSegment,
  DecryptError,
  encryptedSize,
  HEADER_SIZE,
  newFile,
  openHeader,
  plainSize,
  SEGMENT_SIZE,
  segmentCount,
  segmentLocation,
} from '../../src/server/crypto/format.ts';
import {
  createVault,
  decodeRecoveryKey,
  encodeRecoveryKey,
  NameCipher,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
} from '../../src/server/crypto/keys.ts';
import { FAST_KDF, randomData } from './helpers.ts';

async function encryptAll(master: Buffer, plain: Buffer) {
  const fc = newFile(master);
  const ct = await ciphertextRange(fc, plain.length, 0, encryptedSize(plain.length), async (o, l) => plain.subarray(o, o + l));
  return { fc, ct };
}

function decryptAll(master: Buffer, ct: Buffer): Buffer {
  const size = plainSize(ct.length);
  const fc = openHeader(master, ct.subarray(0, HEADER_SIZE));
  const out: Buffer[] = [];
  const n = segmentCount(size);
  for (let i = 0; i < n; i++) {
    const loc = segmentLocation(i, size);
    out.push(decryptSegment(fc, i, i === n - 1, ct.subarray(loc.offset, loc.offset + loc.length)));
  }
  return Buffer.concat(out);
}

describe('file format', () => {
  const master = randomBytes(32);

  it.each([0, 1, SEGMENT_SIZE - 1, SEGMENT_SIZE, SEGMENT_SIZE + 1, 3 * SEGMENT_SIZE + 12345])('round-trips %i bytes', async (n) => {
    const plain = randomData(n);
    const { ct } = await encryptAll(master, plain);
    expect(ct.length).toBe(encryptedSize(n));
    expect(plainSize(ct.length)).toBe(n);
    expect(decryptAll(master, ct).equals(plain)).toBe(true);
  });

  it('produces identical bytes for any sub-range (needed for resumable uploads)', async () => {
    const plain = randomData(2 * SEGMENT_SIZE + 999);
    const { fc, ct } = await encryptAll(master, plain);
    const read = async (o: number, l: number) => plain.subarray(o, o + l);
    for (const [a, b] of [[0, 10], [HEADER_SIZE - 5, HEADER_SIZE + 5], [SEGMENT_SIZE, SEGMENT_SIZE + 100], [100, ct.length]]) {
      const part = await ciphertextRange(fc, plain.length, a!, b!, read);
      expect(part.equals(ct.subarray(a, b))).toBe(true);
    }
  });

  it('detects a flipped bit', async () => {
    const { ct } = await encryptAll(master, randomData(5000));
    ct[HEADER_SIZE + 10]! ^= 1;
    expect(() => decryptAll(master, ct)).toThrow(DecryptError);
  });

  it('detects truncation at a segment boundary', async () => {
    const plain = randomData(2 * SEGMENT_SIZE);
    const { ct } = await encryptAll(master, plain);
    const truncated = ct.subarray(0, HEADER_SIZE + SEGMENT_SIZE + 16); // drop the last segment entirely
    // The remaining segment was not marked "last", so decryption must fail.
    expect(() => decryptAll(master, truncated)).toThrow(DecryptError);
  });

  it('detects reordered segments', async () => {
    const plain = randomData(3 * SEGMENT_SIZE);
    const { ct } = await encryptAll(master, plain);
    const s0 = segmentLocation(0, plain.length);
    const s1 = segmentLocation(1, plain.length);
    const swapped = Buffer.from(ct);
    ct.copy(swapped, s0.offset, s1.offset, s1.offset + s1.length);
    ct.copy(swapped, s1.offset, s0.offset, s0.offset + s0.length);
    expect(() => decryptAll(master, swapped)).toThrow(DecryptError);
  });

  it('rejects the wrong master key and foreign headers', async () => {
    const { ct } = await encryptAll(master, randomData(10));
    expect(() => openHeader(randomBytes(32), ct)).toThrow(DecryptError);
    expect(() => openHeader(master, Buffer.from('not a header'.padEnd(HEADER_SIZE)))).toThrow(DecryptError);
  });

  it('rejects impossible ciphertext lengths', () => {
    expect(() => plainSize(HEADER_SIZE + 3)).toThrow(DecryptError);
  });
});

describe('vault keys', () => {
  it('unlocks with passphrase and recovery key, and rejects wrong ones', async () => {
    const { doc, masterKey, recoveryKey } = await createVault('correct horse battery', FAST_KDF);
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect((await unlockWithPassphrase(doc, 'correct horse battery')).equals(masterKey)).toBe(true);
    expect(unlockWithRecoveryKey(doc, recoveryKey.toLowerCase().replace(/-/g, ' ')).equals(masterKey)).toBe(true);
    await expect(unlockWithPassphrase(doc, 'wrong passphrase')).rejects.toThrow(/wrong passphrase/);
    expect(() => unlockWithRecoveryKey(doc, encodeRecoveryKey(randomBytes(32)))).toThrow(/wrong recovery key/);
    expect(JSON.stringify(doc)).not.toContain(masterKey.toString('base64'));
  });

  it('round-trips recovery keys and tolerates common typos', () => {
    const raw = randomBytes(32);
    const enc = encodeRecoveryKey(raw);
    expect(decodeRecoveryKey(enc).equals(raw)).toBe(true);
    expect(decodeRecoveryKey(enc.replace(/0/g, 'O').replace(/1/g, 'l')).equals(raw)).toBe(true);
    expect(() => decodeRecoveryKey('too-short')).toThrow();
  });
});

describe('name encryption', () => {
  const names = new NameCipher(randomBytes(32));
  it('is deterministic, reversible and filesystem-safe', () => {
    const a = names.encrypt('Kyoto walk 4K.mov');
    expect(names.encrypt('Kyoto walk 4K.mov')).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('Kyoto');
    expect(names.decrypt(a)).toBe('Kyoto walk 4K.mov');
    expect(names.encrypt('é.txt'.normalize('NFD'))).toBe(names.encrypt('é.txt'.normalize('NFC')));
  });
  it('rejects names from another key or tampered names', () => {
    const other = new NameCipher(randomBytes(32));
    expect(() => names.decrypt(other.encrypt('x'))).toThrow(DecryptError);
    expect(() => names.decrypt('plain-name.txt')).toThrow(DecryptError);
  });
  it('refuses names that would exceed 255 bytes once encrypted', () => {
    expect(() => names.encrypt('a'.repeat(200))).toThrow(/too long/);
  });
});
