# Architecture decisions

## ADR-1: Platform. A local daemon with a web UI, not a native macOS extension (yet)

**Context.** The reference is a native macOS app built on FSKit (macOS 26).
A true Finder-native, on-demand file system needs Xcode, a signed system
extension and an Apple Developer account. None of these are in the
development environment: only Command Line Tools are installed, with no
Xcode and no Rust toolchain. A macOS-only design would also drop Linux,
Windows and headless servers.

**Decision.** Farshelf is a **local daemon** with three parts:

1. A **WebDAV server** on loopback. WebDAV is an open standard that every
   major desktop file manager can mount without third-party drivers.
2. An **HTTP Range streaming endpoint** for media players and browsers.
3. A **web UI** served by the same daemon.

A native file-system front end (FSKit File Provider on macOS, or FUSE/NFS)
can be added later on top of the same core.

**Consequences.** The project is cross-platform and works headless on a
NAS. The trade-off is that "zero bytes in Finder" depends on the OS's
WebDAV client, which may cache whole files (see KNOWN_LIMITATIONS). The
`/stream` URLs always do true range reads.

## ADR-2: Language and runtime. TypeScript on Node.js 22.18+ with no native modules

The brief suggested Tauri 2 and Rust. Rust is not installed here, and Tauri
can't be built without it. Node.js 25 is installed, and from 22.13 Node
ships `node:sqlite` (SQLite with FTS5) and `node:crypto` (AES-GCM, scrypt,
HKDF). That gives us:

- **No native add-ons.** `npm install` never compiles C++, so it works the
  same on macOS, Linux and Windows.
- One language for the daemon and the UI, and shared Zod schemas.

A Tauri desktop shell (tray icon, global hotkey, autostart) is the
**planned next step**. It would wrap the same daemon and UI, so the Node
core doesn't have to be rewritten.

## ADR-3: Frontend. React, Vite, Tailwind CSS v4 and native HTML semantics

The UI uses plain React 19 with no router library (four views), and
Tailwind for styling. Interactive patterns (dialogs, the command palette,
lists) are built on native `<dialog>`, `<button>` and ARIA listbox patterns,
which keeps dependencies small. Tests use Vitest and Testing Library, plus
Playwright end-to-end against the system Chrome.

## ADR-4: Persistence. A single SQLite database

`~/.local/share/farshelf/farshelf.db` (macOS:
`~/Library/Application Support/Farshelf`) holds remotes, the metadata
catalog (plus an FTS5 index), jobs, activity, settings and wrapped keys. It
runs in WAL mode. Schema migrations are numbered SQL steps.

## ADR-5: Jobs. Explicit state machines in the database

Uploads and index crawls are rows in `jobs`, with states
`queued → running → (paused | done | failed | cancelled)`. Only the
scheduler moves a job between states, and every transition is validated. On
start-up, `running` jobs are reset to `queued`, which gives restart
recovery. Progress events reach the UI over Server-Sent Events.

## ADR-6: Backends. A narrow interface

```
list(dir) · stat(path) · read(path, start, endExclusive) · mkdir · move · remove
upload: begin(path, size) → session · offset(session) · put(session, offset, bytes) · finish
```

- `local`: any directory (an external disk, NAS mount, or a folder another
  sync client manages).
- `webdav`: Nextcloud, ownCloud, Apache/nginx DAV and similar.
- `gdrive`: Google Drive API v3 with the `drive.file` scope, using
  resumable sessions natively.

Dropbox would fit the same interface. It is on the roadmap.

## ADR-7: Encryption. Our own documented format built from standard parts

The format is specified in `docs/FORMAT.md`. In summary:

- The master key (32 random bytes) is wrapped with AES-256-GCM by a key
  derived from the passphrase with **scrypt** (N=2^17, r=8, p=1). scrypt is
  built into Node. Argon2id would need a third-party WASM dependency.
- A **recovery key** (32 random bytes, base32 in groups) wraps a second copy
  of the master key.
- Each file has a random file key wrapped by the master key in a fixed-size
  header. The content is split into **1 MiB segments**, encrypted with
  AES-256-GCM using the **STREAM** nonce construction:
  `prefix(7) || segment index(4, BE) || last flag(1)`.
- Names use a deterministic SIV-style construction: the AES-GCM nonce is
  HMAC-SHA256(nameKey, plaintext) truncated, so the same name always
  encrypts the same way. Names are base64url-encoded.

Why 1 MiB rather than larger segments: a seek fetches at most 1 MiB of
extra data, while the tag overhead stays small (16 bytes per MiB).

## ADR-8: Local security boundary

- Listens on **127.0.0.1 only** by default. Binding to other interfaces
  needs `--host` and prints a warning.
- The API needs a **session cookie** (`HttpOnly`, `SameSite=Strict`). You
  get it by visiting a one-time login URL that the CLI prints. The token
  file is mode 0600.
- WebDAV and stream endpoints accept HTTP Basic auth (user `farshelf`,
  password = the WebDAV password) or the session cookie.
- The **Host header is checked** against an allow-list, which blocks DNS
  rebinding. State-changing API calls also need a matching `Origin`.
- Child processes run only with fixed argument vectors: `security`,
  `secret-tool` and `osascript` for mounting. Nothing goes through a shell
  and no input comes from an AI model.

## ADR-9: AI. Optional, off by default, metadata-only

Two providers are supported: Ollama (`/api/chat`) and any
OpenAI-compatible `/v1/chat/completions` endpoint. The model never receives
file contents. **NL search** sends only the user's question and gets back a
Zod-validated filter, which runs locally in SQLite. **The assistant** may
also receive the names, sizes and dates in the current folder, but only if
you tick a box for each request. Names from encrypted remotes are never
included. The model can only *propose* operations from a fixed tool list
(`mkdir`, `move`, `trash`). The UI shows them for approval and the daemon
runs the approved ones. API keys go in the OS keychain when one is
available, and otherwise in the database with a clear warning.

## ADR-10: Not a "web3"/microservice system

There is one process and one database. There is no central server, no
account system and no telemetry.
