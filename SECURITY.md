# Security policy

## Supported versions

Only the latest release on `main` receives fixes while Farshelf is 0.x.

## Reporting a vulnerability

Please **don't open a public issue.** Use GitHub's private reporting instead:
**Security › Report a vulnerability** on this repository. Include:

- the affected version or commit
- steps to reproduce, or a proof of concept
- the impact you see (for example: data exposure, encryption bypass, remote access to
  the daemon)

You'll get an acknowledgement within 7 days. Fixes are credited in the changelog
unless you prefer to stay anonymous.

Especially valuable: bugs in the encryption format or its implementation, ways to
reach the daemon from a web page or another host, path traversal, and ways AI output
could cause actions without approval.

The threat model is in [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).
