# Releasing

Farshelf follows [Semantic Versioning](https://semver.org/). While it is 0.x, minor
versions may change the CLI or settings. **The encryption format version only changes
together with a migration and a major note in the changelog.**

1. Update `version` in `package.json` and `VERSION` in `src/server/app.ts`.
2. Add a section to `CHANGELOG.md`.
3. Run `npm run check && npm run test:e2e`.
4. Commit, tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
5. The **Release** workflow builds, tests and packs (`npm pack`). It then creates a
   GitHub release with the tarball and its SHA-256 checksum. Users install it with
   `npm install -g farshelf-0.1.0.tgz`.

Publishing to the npm registry is optional, done manually with `npm publish`, and not
automated.
