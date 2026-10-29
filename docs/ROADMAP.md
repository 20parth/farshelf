# Roadmap

Priorities, not promises. Contributions are welcome on any of these.

## Next

1. **Desktop shell (Tauri 2):** tray icon, drop-on-tray uploads, global search hotkey,
   start at login. It wraps the existing daemon and UI.
2. **Dropbox backend** (app-folder scope, upload sessions).
3. **Native on-demand mount:** a macOS FSKit/File Provider extension, or FUSE/NFS on
   Linux, so file managers read only the ranges apps need.
4. **Share links:** provider links for plain files, plus a static decryptor page with
   the key in the URL fragment for encrypted files.

## Later

- S3-compatible backend (MinIO, Backblaze B2, Cloudflare R2).
- Resumable WebDAV uploads using Nextcloud chunking v2.
- WebDAV folder COPY; cross-remote moves.
- Argon2id KDF option and master-key rotation.
- Windows testing and packaging; signed release binaries.
- Optional local semantic search over file names using local embeddings.

## Not planned

- A hosted Farshelf service, accounts, telemetry or paid tiers.
