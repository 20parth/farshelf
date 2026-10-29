// Farshelf encrypted file format v1. Specified in docs/FORMAT.md; keep the two in sync.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SEGMENT_SIZE = 1024 * 1024;
export const TAG_SIZE = 16;
const MAGIC = Buffer.from('FSH1', 'ascii');
const VERSION = 1;
const PREFIX_SIZE = 7;
const WRAP_NONCE_SIZE = 12;
const FILE_KEY_SIZE = 32;
// magic(4) version(1) reserved(3) prefix(7) pad(1) wrapNonce(12) wrappedKey(32) wrapTag(16)
export const HEADER_SIZE = 4 + 1 + 3 + PREFIX_SIZE + 1 + WRAP_NONCE_SIZE + FILE_KEY_SIZE + TAG_SIZE;

export class DecryptError extends Error {
  override name = 'DecryptError';
}

export interface FileCrypto {
  header: Buffer;
  fileKey: Buffer;
  prefix: Buffer;
}

export function aesGcmEncrypt(key: Buffer, nonce: Buffer, plaintext: Uint8Array, aad?: Uint8Array): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

export function aesGcmDecrypt(key: Buffer, nonce: Buffer, sealed: Uint8Array, aad?: Uint8Array): Buffer {
  if (sealed.length < TAG_SIZE) throw new DecryptError('ciphertext too short');
  const body = sealed.subarray(0, sealed.length - TAG_SIZE);
  const tag = sealed.subarray(sealed.length - TAG_SIZE);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new DecryptError('authentication failed');
  }
}

/** Create a fresh per-file key and header, wrapping the file key with the master key. */
export function newFile(masterKey: Buffer): FileCrypto {
  const fileKey = randomBytes(FILE_KEY_SIZE);
  const prefix = randomBytes(PREFIX_SIZE);
  const wrapNonce = randomBytes(WRAP_NONCE_SIZE);
  const fixed = Buffer.alloc(16);
  MAGIC.copy(fixed, 0);
  fixed[4] = VERSION;
  prefix.copy(fixed, 8);
  const wrapped = aesGcmEncrypt(masterKey, wrapNonce, fileKey, fixed);
  const header = Buffer.concat([fixed, wrapNonce, wrapped]);
  return { header, fileKey, prefix };
}

/** Parse a header and unwrap its file key. */
export function openHeader(masterKey: Buffer, header: Uint8Array): FileCrypto {
  if (header.length < HEADER_SIZE) throw new DecryptError('header too short');
  const h = Buffer.from(header.subarray(0, HEADER_SIZE));
  if (!h.subarray(0, 4).equals(MAGIC)) throw new DecryptError('not a Farshelf encrypted file');
  if (h[4] !== VERSION) throw new DecryptError(`unsupported format version ${h[4]}`);
  const fixed = h.subarray(0, 16);
  const prefix = Buffer.from(h.subarray(8, 8 + PREFIX_SIZE));
  const wrapNonce = h.subarray(16, 16 + WRAP_NONCE_SIZE);
  const wrapped = h.subarray(16 + WRAP_NONCE_SIZE);
  const fileKey = aesGcmDecrypt(masterKey, wrapNonce, wrapped, fixed);
  return { header: h, fileKey, prefix };
}

/** STREAM nonce: prefix(7) || index(4, big-endian) || last(1). */
export function segmentNonce(prefix: Buffer, index: number, last: boolean): Buffer {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new RangeError('segment index out of range');
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, PREFIX_SIZE);
  n[11] = last ? 1 : 0;
  return n;
}

export function segmentCount(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / SEGMENT_SIZE));
}

export function encryptedSize(plainSize: number): number {
  return HEADER_SIZE + plainSize + TAG_SIZE * segmentCount(plainSize);
}

export function plainSize(cipherSize: number): number {
  const body = cipherSize - HEADER_SIZE;
  if (body < TAG_SIZE) throw new DecryptError('ciphertext too short');
  const segments = Math.ceil(body / (SEGMENT_SIZE + TAG_SIZE));
  const size = body - TAG_SIZE * segments;
  if (encryptedSize(size) !== cipherSize) throw new DecryptError('ciphertext has an impossible length');
  return size;
}

/** Byte offset and length of segment `index` inside the ciphertext. */
export function segmentLocation(index: number, plain: number): { offset: number; length: number } {
  const count = segmentCount(plain);
  if (index >= count) throw new RangeError('segment beyond end of file');
  const plainLen = index === count - 1 ? plain - index * SEGMENT_SIZE : SEGMENT_SIZE;
  return { offset: HEADER_SIZE + index * (SEGMENT_SIZE + TAG_SIZE), length: plainLen + TAG_SIZE };
}

export function encryptSegment(fc: FileCrypto, index: number, last: boolean, plain: Uint8Array): Buffer {
  return aesGcmEncrypt(fc.fileKey, segmentNonce(fc.prefix, index, last), plain, fc.header);
}

export function decryptSegment(fc: FileCrypto, index: number, last: boolean, sealed: Uint8Array): Buffer {
  return aesGcmDecrypt(fc.fileKey, segmentNonce(fc.prefix, index, last), sealed, fc.header);
}

/**
 * Produce ciphertext bytes [start, end) for a plaintext of `size` bytes, reading plaintext through `readPlain`.
 * Deterministic for a given FileCrypto, which is what lets uploads resume mid-file.
 */
export async function ciphertextRange(
  fc: FileCrypto,
  size: number,
  start: number,
  end: number,
  readPlain: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<Buffer> {
  const total = encryptedSize(size);
  end = Math.min(end, total);
  if (start >= end) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let pos = start;
  if (pos < HEADER_SIZE) {
    parts.push(fc.header.subarray(pos, Math.min(end, HEADER_SIZE)));
    pos = Math.min(end, HEADER_SIZE);
  }
  const count = segmentCount(size);
  while (pos < end) {
    const index = Math.floor((pos - HEADER_SIZE) / (SEGMENT_SIZE + TAG_SIZE));
    const loc = segmentLocation(index, size);
    const plainLen = loc.length - TAG_SIZE;
    const plain = await readPlain(index * SEGMENT_SIZE, plainLen);
    if (plain.length !== plainLen) throw new Error('source file changed while encrypting');
    const sealed = encryptSegment(fc, index, index === count - 1, plain);
    const from = pos - loc.offset;
    const to = Math.min(loc.length, end - loc.offset);
    parts.push(sealed.subarray(from, to));
    pos = loc.offset + to;
  }
  return Buffer.concat(parts);
}
