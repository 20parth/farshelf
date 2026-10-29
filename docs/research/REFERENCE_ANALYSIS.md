# Reference analysis: feather drive (featherdrive.app)

Investigated on 2026-10-29 from public sources only: the marketing site
(`/`), `/security`, `/privacy`, `/changelog`, and the FAQ section of the
homepage. The `/terms` page was not reviewed in detail.

## What we did not do

- We did **not** download, install, decompile or run the feather drive app.
  It is a proprietary, paid product (one-time licence after a 3-day trial),
  and installing it needs a Google or Dropbox sign-in plus a macOS 26
  file-system extension approval. Nothing below comes from its binaries.
- We did not inspect the app's network traffic, APIs or private endpoints.
- We did not copy any text, artwork, branding or code. The site states that
  the product, its design, copy and code are © 2026 feather drive, all
  rights reserved. Farshelf is an independent implementation of the same
  _problem space_ (mounting your existing cloud storage on the desktop
  without local copies). Products such as rclone already work in that space.

Everything in "verified" below is verified **as a public claim on the
website**, not as tested behaviour of the app.

## Product identity

| Item             | Finding                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name             | feather drive (stylised lowercase)                                                                                                                                                      |
| Platform         | Native macOS app, macOS 26 "Tahoe" or later. Mac only.                                                                                                                                  |
| Category         | Desktop file-system integration for cloud storage ("your cloud, as an infinite mac disk")                                                                                               |
| Storage backends | Google Drive and Dropbox ("more coming")                                                                                                                                                |
| Business model   | 3-day trial, then a one-time US$19.99 licence (up to 3 Macs, free 1.x updates). After the trial, existing files stay readable but you can't add new ones. Payments go through Razorpay. |
| Author           | One independent developer ("sumit")                                                                                                                                                     |
| Version          | 1.0, first public release                                                                                                                                                               |
| Web app          | The privacy and security pages mention a web app that can unlock encrypted files. It was not found or examined.                                                                         |

## Core concept

The cloud account becomes a location in Finder. Files show as **zero bytes
on disk**. When an app reads a file, macOS asks the file-system extension for
specific **byte ranges**. The extension fetches only those ranges (plus some
read-ahead) from the cloud through a **small capped cache**, then evicts
them. The site credits this to the FSKit file-system extensions Apple added
in macOS 26, which is why older macOS versions aren't supported.

## Claimed features (from changelog 1.0 and homepage)

1. One Finder location with a subfolder per connected cloud.
2. Streaming open: any app (QuickTime, VLC, IINA, Final Cut, Resolve, Logic,
   Lightroom, Premiere, CapCut) reads only the ranges it needs. The site
   targets "< 9.9 s" from click to first frame for a 48 GB file.
3. Normal Finder operations: drag in, rename, delete. Deleted items go to a
   30-day trash (Google) or Dropbox's own deleted-files area.
4. Drop files on the menu-bar icon to upload. With two clouds connected you
   pick the target, and the last one used is the default.
5. Resumable uploads that continue after sleep or a lost connection, with
   per-file progress and an estimated time left.
6. Offline: opening needs a connection, but new files queue and upload on
   reconnect.
7. Global search hotkey (⌃⌥F) across the whole drive, with actions: open,
   reveal in Finder (⌘⏎), copy share link (⌘⇧C).
8. Share links. For encrypted files the key goes in the URL fragment.
9. Optional end-to-end encryption (details below).
10. Settings: clear cache, sign out (deletes tokens and cache), opt out of
    usage stats, send feedback.

## Publicly documented security design (from /security)

- 256-bit random master key. The passphrase goes through Argon2id (64 MiB,
  3 passes) to wrap the master key. A 24-word BIP39 recovery phrase wraps a
  second copy. The wrapped keys are stored in the cloud and the unwrapped
  keys in the macOS Keychain.
- Each file has its own random key, wrapped by the master key and stored in
  a header.
- Contents use AES-256-GCM in 4 MiB segments. Segment position and an
  "is last" flag are bound in, which blocks reordering and truncation.
  Segments make range reads possible on encrypted files.
- File names, folder names and the original size are encrypted.
- Threat model: protects against the cloud provider reading contents or
  names. It does not protect against malware on an unlocked Mac, against
  share-link recipients, or against size and timing leaks.
- Google OAuth uses PKCE with only the `drive.file` scope, so the app sees
  only files it created. Dropbox uses an "app folder". Tokens are kept in
  the Keychain.

These are standard published constructions: the STREAM online-AEAD pattern
and envelope encryption. Farshelf implements its own documented format
based on the public literature (see `ARCHITECTURE_DECISIONS.md`), not on
feather drive's file format, which we have not seen.

## Privacy observations

- No feather drive server handles file contents or tokens.
- The marketing site loads Google Analytics through gtag. It shows a consent
  banner and claims cookieless measurement until you accept.
- **The app sends anonymous usage events to PostHog by default** (opt-out in
  settings). This is a clear point where Farshelf can be different: no
  telemetry at all.
- Licence activation sends a hashed hardware id and the Mac's name to the
  vendor.

## Observed site quality

- Responsive: at 375 px wide there is no horizontal overflow. A cookie
  banner covers the lower part of the first screen.
- `lang="en"` is set. 25 `<img>` elements have no `alt` attribute (many may
  be decorative). We did not run a full accessibility audit.
- It uses GSAP animations loaded from cdnjs.

## Gaps and weaknesses (opportunities)

| Gap                                                            | Why it matters                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Mac only, macOS 26+ only                                       | Excludes Linux, Windows and older Macs                                         |
| Closed source, paid                                            | Users can't audit the crypto or self-host                                      |
| Default-on telemetry                                           | A privacy-conscious audience may object                                        |
| Only Google Drive and Dropbox                                  | No self-hosted backends (WebDAV/Nextcloud, NAS, S3)                            |
| No headless/server mode                                        | Teams can't run it on a home server or NAS                                     |
| No published file-format spec                                  | Users depend on the vendor for long-term decryptability                        |
| No upload history or search across past activity was mentioned | Hard to audit what happened                                                    |
| Search is filename-only (as far as described)                  | No natural-language or attribute queries ("videos over 10 GB from last month") |
