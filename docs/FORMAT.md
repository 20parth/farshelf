# Farshelf encryption format, version 1

This document specifies how an encrypted Farshelf remote is stored, so the data stays
readable without Farshelf itself. The reference implementation is
`src/server/crypto/format.ts`, `src/server/crypto/keys.ts` and `src/server/decrypt.ts`.
The tests in `tests/server/crypto.test.ts` exercise it.

All integers are big-endian. "AES-GCM" always means AES-256-GCM with a 12-byte nonce
and a 16-byte tag appended to the ciphertext.

## Layout on the storage

```
/.farshelf/vault.json          key file (JSON, below)
/.farshelf-trash/<id>/<name>   trashed items (name encrypted)
/<enc name>/<enc name>/...     your files and folders
```

## Key file (`vault.json`)

```json
{
  "format": "farshelf-vault",
  "version": 1,
  "kdf": { "alg": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64, 16 bytes>" },
  "passphrase": { "nonce": "<base64>", "ct": "<base64>" },
  "recovery": { "nonce": "<base64>", "ct": "<base64>" }
}
```

- **Master key** `MK`: 32 random bytes.
- **Passphrase wrap:** `K_p = scrypt(NFKC(passphrase), salt, N, r, p, dkLen=32)`, and
  `passphrase.ct = AES-GCM(K_p, nonce, MK, aad="farshelf-vault-v1")`.
- **Recovery key:** 32 random bytes `R`, shown once as 52 Crockford-base32 characters
  in groups of four. Decoders accept lowercase and spaces, and treat `O`→`0` and
  `I`/`L`→`1`. `K_r = HKDF-SHA256(ikm=R, salt=empty, info="farshelf recovery wrap v1", 32)`,
  and `recovery.ct = AES-GCM(K_r, nonce, MK, aad="farshelf-vault-v1")`.

Changing the passphrase rewrites only `kdf` and `passphrase`.

## Names

`NK || NM = HKDF-SHA256(ikm=MK, salt=empty, info="farshelf names v1", 64)`. Each path
segment is encrypted on its own:

```
plain = UTF-8(NFC(name))
nonce = HMAC-SHA256(NM, plain)[0..12]
enc   = base64url_nopad(nonce || AES-GCM(NK, nonce, plain))
```

The scheme is deterministic (SIV-style), so a given name always maps to the same stored
name. Equal names therefore have equal ciphertexts. Decoders must check that the nonce
equals the recomputed HMAC. Names whose encoding exceeds 255 characters are rejected
(about 160 bytes of plaintext).

## Files

```
header (76 bytes) || segment_0 || segment_1 || ... || segment_{n-1}
```

### Header

| Offset | Size | Field                                        |
| ------ | ---- | -------------------------------------------- |
| 0      | 4    | magic `FSH1`                                 |
| 4      | 1    | version = 1                                  |
| 5      | 3    | reserved, zero                               |
| 8      | 7    | `prefix`: random STREAM nonce prefix         |
| 15     | 1    | reserved, zero                               |
| 16     | 12   | `wnonce`: random                             |
| 28     | 48   | `AES-GCM(MK, wnonce, FK, aad=header[0..16])` |

`FK` is a random 32-byte per-file key.

### Segments

The plaintext is split into segments of `S = 1 MiB` (1,048,576 bytes). The last segment
may be shorter, and an empty file has exactly one empty segment.
`n = max(1, ceil(P / S))`.

```
nonce_i   = prefix (7) || uint32(i) (4) || last (1: 0x01 for i = n-1, else 0x00)
segment_i = AES-GCM(FK, nonce_i, plaintext_i, aad = header (all 76 bytes))
```

This is the STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár, 2015). Binding
the index and the last-segment flag stops reordering, duplication and truncation.
Binding the header stops header swaps.

### Sizes

```
C = 76 + P + 16 * max(1, ceil(P / S))
```

Readers recover `P` from `C`. With `x = C - 76` and `k = ceil(x / (S + 16))`,
`P = x - 16k`. Readers must then check that the formula gives back `C`. Segment `i`
starts at `76 + i * (S + 16)`. Reading plaintext bytes `[a, b)` needs only segments
`floor(a/S)` to `floor((b-1)/S)`, which is what makes encrypted streaming possible.

## What the format does not hide

- The size of each file (to within one segment's tag) and the number and depth of
  folders.
- Which files have the same name (deterministic names).
- Access patterns and timing, as seen by the storage provider.
- Whole-file substitution. A file's path is not bound into its ciphertext, so the
  storage provider could swap two of your encrypted files.
