# User flows

The reference flows come from the public website only. The Farshelf flows
describe what this repository implements.

## Reference: feather drive (as described publicly)

1. **Install.** Open the DMG and drag the app to Applications. A menu-bar
   icon appears.
2. **Enable the extension.** On first launch macOS asks you to allow the
   file-system extension. The app points to System Settings › General ›
   Login Items & Extensions › File System Extensions.
3. **Sign in.** One "sign in with Google" button grants `drive.file`.
   Dropbox can be added too.
4. **Optional encryption.** Set a passphrase, then save the 24-word
   recovery key before continuing.
5. **Use it.** Feather Drive appears in Finder with a folder per cloud.
   Drag big folders in to free disk space.
6. **Open.** Double-click any file and it streams.
7. **Quick upload.** Drop files on the menu-bar icon and choose the cloud.
8. **Search.** ⌃⌥F from any app, then Return to open, ⌘⏎ to reveal, or
   ⌘⇧C to copy a share link.
9. **Trial end.** After 3 days, existing files stay readable but adding
   files needs a licence.

## Farshelf

### F1. First run (about 1 minute)
1. `npx farshelf` (or `farshelf start`) starts the daemon on
   `127.0.0.1:7420`, then prints and opens a one-time login URL.
2. The UI shows **onboarding** because no remote exists yet. The default
   choice is **Local folder**, with the path pre-filled as
   `~/Farshelf Storage`. Other choices are WebDAV / Nextcloud and Google
   Drive.
3. The optional "Encrypt this remote" toggle asks for a passphrase. The
   recovery key is shown once, and you must confirm you saved it before
   continuing.
4. The remote appears in the sidebar and the file browser opens on it.

### F2. Upload
1. Drag files onto the window, or click **Upload**. Files are copied into
   the local spool. The UI lists them as *queued* straight away.
2. The Transfers view shows progress, rate and ETA. You can pause, resume,
   cancel or retry.
3. If the daemon stops or the network drops, the job goes back to *queued*
   and resumes from the last confirmed offset when possible.
4. When it finishes, the spool copy is deleted and the activity log records
   the upload.

### F3. Open / stream
1. Click a file. Media and PDFs open in a new tab through
   `/stream/<remote>/<path>`, which supports HTTP Range. Use **Copy stream
   link** to paste the URL into VLC or IINA.
2. Only the requested ranges are fetched (plus read-ahead), through the
   capped cache.

### F4. Mount in the file manager
Settings › Mount shows the WebDAV URL and the generated credentials, plus
platform steps. On macOS there's a **Mount in Finder** button that mounts
through `osascript`.

### F5. Search (⌘K)
Type to search file names across indexed remotes. Use the arrow keys to
move, Return to open, ⌘Return to show the containing folder, and ⌘⇧C to
copy the stream link. If AI is on, "Ask AI" turns the question into a
filter, shows it, and runs it locally.

### F6. AI assistant (optional)
1. Settings › AI: choose Ollama (default URL `http://127.0.0.1:11434`) or
   an OpenAI-compatible endpoint, then click Test.
2. In the palette, type a request (for example "move all wav files in Music
   into a new folder called stems"). Choose whether to share file names
   from the current folder.
3. The assistant returns a **plan**: a list of proposed operations with
   their inputs, labelled as AI suggestions.
4. You approve or reject each step. Approved steps run and show their
   results. Nothing runs without approval.

### F7. Recover
- **Trash:** restore or permanently delete. Items older than 30 days are
  purged automatically.
- **Locked encrypted remote after restart** (no keychain): enter the
  passphrase or the recovery key.

### F8. Leave cleanly
Settings › Remote › Remove deletes the tokens, catalog rows and cached data
for that remote. Your remote files are not touched.
`farshelf reset` removes all Farshelf data.
