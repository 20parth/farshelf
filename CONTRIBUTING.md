# Contributing to Farshelf

Thanks for helping! Farshelf aims to stay small, understandable and private by default.

## Development setup

Requirements: Node.js 22.18+ and npm. Optional: Google Chrome for the end-to-end test.

```bash
npm ci
npm run build                 # web UI + daemon
node src/server/cli.ts start --home .farshelf-dev/home --secrets memory --no-open
```

Node runs the TypeScript sources directly (type stripping). For hot-reloading UI work,
run the daemon with `FARSHELF_DEV_ORIGIN=http://localhost:5173` and then
`npm run dev:web`. Open the printed login link once on port 7420, then use the Vite
URL.

`.farshelf-dev/` is git-ignored. Never point dev runs at real data without a backup.

## Before opening a pull request

```bash
npm run check        # typecheck, lint, unit/integration/component tests, build
npm run test:e2e     # real browser journey (uses installed Chrome; or PLAYWRIGHT_CHANNEL=chromium)
npm run format       # prettier
```

- Add tests for behaviour changes. Backends need a mock-server test.
- Keep the [encryption format](docs/FORMAT.md) backwards compatible. Format changes
  need a new version number and a migration.
- No telemetry, ads, tracking or calls to services the user did not configure.
- Don't commit secrets, databases or `.env` files.
- Keep docs in sync with code. The README must only claim what works.

## Commit style

Use short imperative subjects (`fix: …`, `feat: …`, `docs: …`), and explain the _why_
in the body.

## Reporting bugs and ideas

Use the issue templates. For security problems, see [SECURITY.md](SECURITY.md); please
don't open a public issue.

By contributing you agree that your contributions are licensed under Apache-2.0.
