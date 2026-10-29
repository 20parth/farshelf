# Configuration

## Command-line flags (`farshelf start`)

| Flag        | Default         | Meaning                                                                                     |
| ----------- | --------------- | ------------------------------------------------------------------------------------------- |
| `--port`    | `7420`          | HTTP port                                                                                   |
| `--host`    | `127.0.0.1`     | Bind address. Anything other than loopback prints a warning; use TLS.                       |
| `--no-open` | off             | Don't open the browser                                                                      |
| `--secrets` | `auto`          | `auto` (OS keychain, else database), `database`, or `memory` (nothing persisted; for tests) |
| `--home`    | OS app-data dir | Data directory (works with every command)                                                   |

## Environment variables

| Variable                                                     | Meaning                                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `FARSHELF_HOME`                                              | Data directory. Defaults: macOS `~/Library/Application Support/Farshelf`, Linux `$XDG_DATA_HOME/farshelf`, Windows `%APPDATA%\Farshelf`. |
| `FARSHELF_PORT`, `FARSHELF_HOST`                             | As the flags                                                                                                                             |
| `FARSHELF_KEYCHAIN`                                          | As `--secrets`                                                                                                                           |
| `FARSHELF_ALLOWED_HOSTS`                                     | Extra comma-separated `host:port` values accepted in the `Host` header, e.g. behind a reverse proxy                                      |
| `FARSHELF_DEV_ORIGIN`                                        | Extra origin allowed to call the API (the Vite dev server, e.g. `http://localhost:5173`)                                                 |
| `FARSHELF_GDRIVE_CLIENT_ID`, `FARSHELF_GDRIVE_CLIENT_SECRET` | Default Google OAuth client, used when the UI fields are left blank                                                                      |
| `FARSHELF_AI_API_KEY`                                        | Fallback API key for OpenAI-compatible endpoints (prefer the UI, which uses the keychain)                                                |
| `FARSHELF_PASSPHRASE`                                        | Used by `farshelf decrypt` instead of prompting                                                                                          |

`.env.example` lists them with placeholders. Farshelf does not read `.env` files
itself.

## Settings (UI › Settings)

| Setting          | Default | Range                              |
| ---------------- | ------- | ---------------------------------- |
| Streaming cache  | 256 MiB | 16–16384, memory only              |
| Read-ahead       | 6 MiB   | 0–32 blocks of 1 MiB               |
| Parallel uploads | 2       | 1–8                                |
| Keep trash for   | 30 days | 1–365                              |
| AI               | off     | provider, endpoint, model, API key |

## Data directory contents

```
farshelf.db      settings, remotes (no secrets unless no keychain), index, jobs, trash, activity
auth.json        login token, WebDAV password, stream-link key (mode 0600)
spool/           files waiting to upload (deleted after upload)
```
