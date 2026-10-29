# Architecture

Farshelf is one Node.js process with one SQLite database. There are no other services.
The reasoning behind each choice is in
[research/ARCHITECTURE_DECISIONS.md](research/ARCHITECTURE_DECISIONS.md).

```
src/
  shared/schemas.ts        Zod schemas + response types shared by daemon and UI
  server/
    cli.ts                 entry point: start / url / decrypt / reset
    app.ts                 the service: remotes, file ops, trash, uploads, indexing, settings
    vault.ts               per-remote layer: name/content encryption, block reads, cache, read-ahead,
                           pending-upload overlay (queued files are visible and readable at once)
    backends/              local.ts · webdav.ts · gdrive.ts behind one small interface (types.ts)
    crypto/                format.ts (segmented AES-GCM STREAM) · keys.ts (vault keys, names)
    jobs.ts                persistent job queue + explicit state machine (uploads, index crawls)
    catalog.ts             metadata index with SQLite FTS5 (names only, never contents)
    activity.ts            searchable activity log
    cache.ts               in-memory LRU block cache
    secrets.ts             macOS Keychain / Secret Service / DB fallback
    db.ts                  migrations
    ai/assistant.ts        Ollama + OpenAI-compatible providers, NL search, plan validation
    http/                  server.ts (auth, host/origin checks, static UI, SSE) · api.ts · dav.ts · stream.ts
  web/                     React 19 + Tailwind v4 UI (Vite)
tests/server, tests/web    Vitest; e2e/ Playwright
```

## Key flows

**Read / stream.** `GET /stream/...` or a WebDAV `GET` with `Range` calls
`Vault.readRange`. That splits the range into 1 MiB blocks. Each block is served from
the LRU cache or fetched with a backend range read, and decrypted when the remote is
encrypted. Identical concurrent fetches are coalesced. Sequential access prefetches the
next _N_ blocks.

**Upload.** Bytes arrive from the UI or WebDAV `PUT` and go to the spool file. Then a
job is created with state `queued`, and the file is listed straight away as `pending`.
The scheduler moves the job to `running`:

- **Resumable backends:** `beginUpload` returns session state, which is saved in the
  job. Chunks are sent, each one confirmed before the next.
- **Other backends:** `putStream` sends the whole file.

When the job reaches `done`, the spool file is deleted, the catalog is updated, and the
activity log and an SSE event record it. A crash leaves the job `running`. On the next
start it goes back to `queued`, asks the backend for the confirmed offset, and
continues. For encrypted remotes the per-file header is stored in the job, and segment
encryption is deterministic for a given header, so resumed bytes match exactly.

**Job states:** `queued → running → done | failed | paused | cancelled`. Also:
`running → queued` (retry with backoff, or restart), `paused → queued`,
`failed → queued` (retry). Other transitions are rejected.

**Trash.** A trashed item moves on the backend to `/.farshelf-trash/<id>/<name>`, and a
DB row remembers its original path. Restore moves it back and re-indexes it. Items
older than the retention period are purged every hour.

**Live UI.** `GET /api/events` is a Server-Sent Events stream of `job`, `changed`,
`state`, `trash` and `activity` events.

## Adding a backend

Implement `Backend` in `src/server/backends/types.ts`:

- `list`, `stat`, `read(start, end)`, `mkdir`, `move`, `remove`
- either the resumable upload methods or `putStream`

Then wire it into `App.makeBackend` and `createRemoteInput`, and add tests against a
mock server, as `tests/server/gdrive.test.ts` does.
