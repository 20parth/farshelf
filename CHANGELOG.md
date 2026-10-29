# Changelog

## 0.1.0 (unreleased)

First public version.

- Daemon with web UI. Storage backends: local folder, WebDAV/Nextcloud, and Google
  Drive (`drive.file`, PKCE, bring your own OAuth client).
- Range streaming with an in-memory block cache and read-ahead. Signed per-file stream
  links.
- WebDAV server for mounting in Finder, Explorer and Linux file managers.
- Persistent, resumable upload queue with pause, resume, cancel, retry and restart
  recovery.
- Optional end-to-end encryption (format v1) with a recovery key, plus offline
  `farshelf decrypt`.
- 30-day trash, an FTS5 search index, and a searchable activity log.
- Optional AI through Ollama or OpenAI-compatible endpoints: natural-language search
  and approval-gated plans.
