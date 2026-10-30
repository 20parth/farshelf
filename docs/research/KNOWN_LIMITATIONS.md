# Known limitations

## Research limitations

- The reference app was **not installed or run**. Every reference "feature"
  is a public claim from featherdrive.app, not observed behaviour. We did
  not measure its performance (for example "< 9.9 s to first frame").
- We did not review the `/terms` page or the reference web app.
- We did not inspect the reference's network traffic, binaries or file
  format, on purpose.

## Farshelf limitations (v0.1)

### File-manager integration

- **OS WebDAV clients may download whole files.** macOS Finder (`webdavfs`)
  and Linux `davfs2` cache a file locally when it is opened. Range reads
  then happen between that client and Farshelf, but the client may still
  fetch the whole file before handing it to the app. For true streaming of
  big media, open the file from the Farshelf UI or paste its **stream
  link** into VLC, IINA or a browser. GNOME's gvfs and Windows' WebClient
  behave differently. A native FSKit/FUSE front end is on the roadmap.
- Windows' WebClient caps file size at 50 MB by default (registry setting
  `FileSizeLimitInBytes`) and prefers HTTPS. See `docs/TROUBLESHOOTING.md`.
- WebDAV `LOCK` is a minimal compatibility stub (so Finder mounts
  read-write). Farshelf does not enforce locks.

### Backends

- **Google Drive** is implemented against the public v3 API and tested
  against a local mock. It has **not been tested against live Google
  servers** in this repository's CI. One-click sign-in needs the publisher to
  register and publish one OAuth client; builds without it ask for your own. Google desktop clients also come with a "client
  secret" that Google documents as not confidential for installed apps.
- **Dropbox is not implemented.**
- WebDAV uploads can't resume mid-file. A failed WebDAV upload restarts
  from byte 0.
- Uploads made through the WebDAV mount are staged in the local spool, so
  they briefly use local disk until the background upload finishes.

### Encryption

- The plaintext size can be worked out from the ciphertext size.
- Changing the passphrase re-wraps the master key. It doesn't re-encrypt
  files. Rotating the master key isn't supported.
- Passphrase stretching uses scrypt rather than Argon2id (no native or WASM
  dependency).
- A Farshelf-encrypted remote can't be read by other tools. Use
  `farshelf decrypt` or the documented format.

### Desktop shell

- No tray icon, global hotkey or autostart yet: these need the planned
  Tauri shell. The ⌘K palette works only inside the UI.
- No public share links yet.

### AI

- AI quality depends on the model you choose. Small local models may return
  invalid plans. These are rejected with a clear error rather than run.
- Paid API providers charge for their own inference. Farshelf has no
  hosted model.

### Platforms

- Development and tests ran on macOS (Apple silicon). Linux and Windows are
  expected to work because there are no native dependencies, and CI runs
  the test suite on Ubuntu. Windows has not been exercised manually.
