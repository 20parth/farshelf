# Troubleshooting

**“Sign in to Farshelf” page.** Open the private login link: run `farshelf url` (or
`node dist/server/server/cli.js url`). Use the same `--home` and port as the running
daemon.

**`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` or a syntax error at start.** You need
Node.js 22.18 or newer: `node --version`.

**Port already in use.** `farshelf start --port 7421`.

**“Misdirected request: unknown Host header”.** You opened Farshelf through a name it
doesn't expect (a LAN IP or a proxy). Add it to `FARSHELF_ALLOWED_HOSTS`, e.g.
`FARSHELF_ALLOWED_HOSTS=nas.local:7420`.

**Storage shows as locked after every restart.** No OS keychain was found (common on
headless Linux), so unlocked keys are not stored. Install `libsecret-tools` /
`secret-tool` with a running keyring, or unlock after each start.

**Finder downloads the whole file before playing.** macOS's WebDAV client caches whole
files. Open the file from the Farshelf UI, or copy its stream link into VLC or IINA.

**Windows: “file size exceeds the limit” or the folder won't map.** WebClient limits
files to 50 MB by default. In
`HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters`, set
`FileSizeLimitInBytes` to `0xFFFFFFFF`. To allow Basic auth over plain HTTP on
loopback, set `BasicAuthLevel` to `2`. Then restart the WebClient service.

**Uploads stay “Waiting”.** Check that the storage is unlocked. Then look in
Transfers, where an error under each job explains it: the network, an expired Google
sign-in, or a full quota. Network errors retry with backoff up to 9 times, then the
job shows **Retry**.

**Google: “refused the stored sign-in”.** The refresh token was revoked or expired
(see the note about Testing mode in AI_AND_PROVIDERS.md). Remove the storage and add
it again. Your files stay in Drive.

**AI: “Cannot reach the AI provider”.** Start Ollama (`ollama serve`) and pull the
model you configured (`ollama pull llama3.2`). Then use **Test connection**.

**“The model's plan was not valid”.** Smaller models sometimes produce malformed
output. Try again, rephrase, or use a larger model. Nothing was changed.

**Start completely fresh.** Stop Farshelf, then run `farshelf reset --yes`. Stored
files are not touched.
